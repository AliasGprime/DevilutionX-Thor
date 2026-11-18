/**
 * @file companion.cpp
 *
 * Implementation of the companion app server. See companion.h.
 *
 * Threading model:
 *  - The game thread builds JSON snapshots (UpdateGame) a few times per second
 *    and publishes them under a mutex.
 *  - A dedicated thread runs an asio io_context with a minimal HTTP/1.1 server
 *    that only ever reads the published strings. It never touches game state.
 */
#include "companion/companion.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>

#include <asio/buffer.hpp>
#include <asio/io_context.hpp>
#include <asio/ip/address.hpp>
#include <asio/ip/tcp.hpp>
#include <asio/read_until.hpp>
#include <asio/steady_timer.hpp>
#include <asio/streambuf.hpp>
#include <asio/write.hpp>
#include <asio_handle_exception.hpp>

#ifdef USE_SDL3
#include <SDL3/SDL_timer.h>
#else
#include <SDL.h>
#endif

#include "automap.h"
#include "game_mode.hpp"
#include "items.h"
#include "levels/dun_tile_data.hpp"
#include "levels/gendung.h"
#include "levels/setmaps.h"
#include "levels/tile_properties.hpp"
#include "levels/trigs.h"
#include "monster.h"
#include "multi.h"
#include "objects.h"
#include "options.h"
#include "player.h"
#include "tables/playerdat.hpp"
#include "tables/questdat.hpp"
#include "tables/spelldat.h"
#include "towners.h"
#include "utils/language.h"
#include "utils/log.hpp"

namespace devilution {
namespace companion {

namespace {

constexpr uint64_t StateRefreshMs = 200;
constexpr uint64_t MapRefreshMs = 500;
constexpr size_t MaxRequestSize = 8192;

// ---------------------------------------------------------------------------
// Minimal JSON writer
// ---------------------------------------------------------------------------

class JsonWriter {
public:
	std::string out;

	JsonWriter()
	{
		out.reserve(16 * 1024);
	}

	JsonWriter &beginObject()
	{
		separator();
		out += '{';
		first_ = true;
		return *this;
	}
	JsonWriter &endObject()
	{
		out += '}';
		first_ = false;
		return *this;
	}
	JsonWriter &beginArray()
	{
		separator();
		out += '[';
		first_ = true;
		return *this;
	}
	JsonWriter &endArray()
	{
		out += ']';
		first_ = false;
		return *this;
	}
	JsonWriter &key(std::string_view k)
	{
		separator();
		appendString(k);
		out += ':';
		first_ = true; // the value must not be preceded by a comma
		return *this;
	}
	JsonWriter &value(std::string_view v)
	{
		separator();
		appendString(v);
		return *this;
	}
	JsonWriter &value(const char *v)
	{
		return value(std::string_view(v != nullptr ? v : ""));
	}
	JsonWriter &value(const std::string &v)
	{
		return value(std::string_view(v));
	}
	JsonWriter &value(bool v)
	{
		separator();
		out += v ? "true" : "false";
		return *this;
	}
	JsonWriter &value(int64_t v)
	{
		separator();
		out += std::to_string(v);
		return *this;
	}
	JsonWriter &value(int v) { return value(static_cast<int64_t>(v)); }
	JsonWriter &value(unsigned v) { return value(static_cast<int64_t>(v)); }
	JsonWriter &null()
	{
		separator();
		out += "null";
		return *this;
	}

	template <typename T>
	JsonWriter &field(std::string_view k, const T &v)
	{
		key(k);
		return value(v);
	}

private:
	bool first_ = true;

	void separator()
	{
		if (!first_)
			out += ',';
		first_ = false;
	}

	void appendString(std::string_view s)
	{
		out += '"';
		for (const char c : s) {
			switch (c) {
			case '"': out += "\\\""; break;
			case '\\': out += "\\\\"; break;
			case '\n': out += "\\n"; break;
			case '\r': out += "\\r"; break;
			case '\t': out += "\\t"; break;
			default:
				if (static_cast<unsigned char>(c) < 0x20) {
					char buf[8];
					std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(static_cast<unsigned char>(c)));
					out += buf;
				} else {
					out += c;
				}
			}
		}
		out += '"';
	}
};

// ---------------------------------------------------------------------------
// Published snapshots (shared between game thread and server thread)
// ---------------------------------------------------------------------------

std::mutex SnapshotMutex;
std::shared_ptr<const std::string> StateJson = std::make_shared<const std::string>(R"({"v":1,"inGame":false})");
std::shared_ptr<const std::string> MapJson = std::make_shared<const std::string>(R"({"v":1,"version":0,"w":0,"h":0,"cells":""})");

void Publish(std::shared_ptr<const std::string> &slot, std::string &&json)
{
	auto ptr = std::make_shared<const std::string>(std::move(json));
	const std::lock_guard<std::mutex> lock(SnapshotMutex);
	slot = std::move(ptr);
}

std::shared_ptr<const std::string> Read(const std::shared_ptr<const std::string> &slot)
{
	const std::lock_guard<std::mutex> lock(SnapshotMutex);
	return slot;
}

// ---------------------------------------------------------------------------
// Snapshot builders (game thread only)
// ---------------------------------------------------------------------------

uint64_t LastStateUpdate = 0;
uint64_t LastMapUpdate = 0;
uint32_t StateSequence = 0;
uint32_t MapVersion = 0;
uint64_t LastMapHash = 0;

std::string GetLocationName()
{
	if (setlevel) {
		return std::string(_(QuestLevelNames[setlvlnum]));
	}

	constexpr std::array<const char *, DTYPE_LAST + 1> DungeonStrs = { N_("Town"), N_("Cathedral"), N_("Catacombs"), N_("Caves"), N_("Hell"), N_("Nest"), N_("Crypt") };
	std::string name = leveltype != DTYPE_NONE ? std::string(_(DungeonStrs[leveltype])) : std::string(_("None"));
	if (currlevel > 0) {
		int level = currlevel;
		if (leveltype == DTYPE_NEST)
			level -= 16;
		else if (leveltype == DTYPE_CRYPT)
			level -= 20;
		name += ' ';
		name += std::to_string(level);
	}
	return name;
}

bool IsCellExplored(int x, int y)
{
	if (leveltype == DTYPE_TOWN)
		return true;
	if (HasAnyOf(dFlags[x][y], DungeonFlag::Explored))
		return true;
	const int dx = (x - 16) / 2;
	const int dy = (y - 16) / 2;
	if (x < 16 || y < 16 || dx >= DMAXX || dy >= DMAXY)
		return false;
	return AutomapView[dx][dy] != MAP_EXP_NONE;
}

bool IsCellVisible(Point p)
{
	return InDungeonBounds(p) && HasAnyOf(dFlags[p.x][p.y], DungeonFlag::Visible);
}

void WriteItem(JsonWriter &w, const Item &item)
{
	if (item.isEmpty()) {
		w.null();
		return;
	}
	w.beginObject();
	w.field("name", std::string(item.getName().str()));
	w.field("quality", static_cast<int>(item._iMagical));
	w.field("identified", item._iIdentified);
	w.field("usable", item._iStatFlag);
	if (item._iMaxDur > 0 && item._iMaxDur != DUR_INDESTRUCTIBLE) {
		w.field("dur", item._iDurability);
		w.field("maxDur", item._iMaxDur);
	}
	if (item._iMaxCharges > 0) {
		w.field("charges", item._iCharges);
		w.field("maxCharges", item._iMaxCharges);
	}
	w.endObject();
}

void WriteStat(JsonWriter &w, std::string_view k, int base, int now, int max)
{
	w.key(k).beginArray().value(base).value(now).value(max).endArray();
}

std::pair<int, int> GetDamage(const Player &player)
{
	int damageMod = player._pIBonusDamMod;
	if (player.InvBody[INVLOC_HAND_LEFT]._itype == ItemType::Bow && player._pClass != HeroClass::Rogue) {
		damageMod += player._pDamageMod / 2;
	} else {
		damageMod += player._pDamageMod;
	}
	const int mindam = player._pIMinDam + (player._pIBonusDam * player._pIMinDam / 100) + damageMod;
	const int maxdam = player._pIMaxDam + (player._pIBonusDam * player._pIMaxDam / 100) + damageMod;
	return { mindam, maxdam };
}

const char *ObjectKind(const Object &object)
{
	if (object.isDoor()) return "door";
	if (object.IsChest()) return "chest";
	if (object.IsShrine()) return "shrine";
	if (object.IsBarrel()) return "barrel";
	if (object.IsTrap()) return "trap";
	return "object";
}

const char *TriggerKind(const TriggerStruct &trig)
{
	switch (trig._tmsg) {
	case WM_DIABNEXTLVL: return "down";
	case WM_DIABPREVLVL: return "up";
	case WM_DIABTOWNWARP: return "warp";
	case WM_DIABTWARPUP: return "town";
	case WM_DIABRTNLVL: return "return";
	case WM_DIABSETLVL: return "quest";
	default: return "other";
	}
}

void WritePlayer(JsonWriter &w, const Player &player)
{
	w.key("player").beginObject();
	w.field("name", player._pName);
	w.field("class", std::string(player.getClassName()));
	w.field("classId", static_cast<int>(player._pClass));
	w.field("level", static_cast<int>(player.getCharacterLevel()));
	w.field("maxLevel", player.isMaxCharacterLevel());
	w.field("xp", static_cast<int64_t>(player._pExperience));
	const unsigned lvl = player.getCharacterLevel();
	w.field("xpPrev", static_cast<int64_t>(lvl > 1 ? GetNextExperienceThresholdForLevel(lvl - 1) : 0));
	w.field("xpNext", static_cast<int64_t>(player.getNextExperienceThreshold()));
	const bool noMana = HasAnyOf(player._pIFlags, ItemSpecialEffect::NoMana);
	w.field("hp", player._pHitPoints.whole());
	w.field("hpMax", player._pMaxHP.whole());
	w.field("mana", noMana || player.hasNoMana() ? 0 : player._pMana.whole());
	w.field("manaMax", noMana ? 0 : player._pMaxMana.whole());
	WriteStat(w, "str", player._pBaseStr, player._pStrength, player.GetMaximumAttributeValue(CharacterAttribute::Strength));
	WriteStat(w, "mag", player._pBaseMag, player._pMagic, player.GetMaximumAttributeValue(CharacterAttribute::Magic));
	WriteStat(w, "dex", player._pBaseDex, player._pDexterity, player.GetMaximumAttributeValue(CharacterAttribute::Dexterity));
	WriteStat(w, "vit", player._pBaseVit, player._pVitality, player.GetMaximumAttributeValue(CharacterAttribute::Vitality));
	w.field("statPoints", player._pStatPts);
	w.field("gold", player._pGold);
	w.field("ac", player.GetArmor() + (player.getCharacterLevel() * 2));
	w.field("toHit", player.InvBody[INVLOC_HAND_LEFT]._itype == ItemType::Bow ? player.GetRangedToHit() : player.GetMeleeToHit());
	const auto [dmgMin, dmgMax] = GetDamage(player);
	w.key("damage").beginArray().value(dmgMin).value(dmgMax).endArray();
	w.key("resist").beginObject();
	w.field("magic", static_cast<int>(player._pMagResist));
	w.field("fire", static_cast<int>(player._pFireResist));
	w.field("lightning", static_cast<int>(player._pLghtResist));
	w.endObject();
	w.key("pos").beginArray().value(player.position.tile.x).value(player.position.tile.y).endArray();
	w.field("dead", player._pmode == PM_DEATH || player.hasNoLife());

	// Readied spell
	w.key("spell");
	if (player._pRSpell != SpellID::Invalid && player._pRSpell != SpellID::Null) {
		w.beginObject();
		w.field("name", std::string(pgettext("spell", GetSpellData(player._pRSpell).sNameText)));
		w.field("type", static_cast<int>(player._pRSplType));
		w.field("level", player.GetSpellLevel(player._pRSpell));
		w.endObject();
	} else {
		w.null();
	}

	w.key("equipment").beginArray();
	for (const Item &item : player.InvBody)
		WriteItem(w, item);
	w.endArray();

	w.key("belt").beginArray();
	for (const Item &item : player.SpdList)
		WriteItem(w, item);
	w.endArray();

	int potionsHeal = 0;
	int potionsMana = 0;
	auto countPotion = [&](const Item &item) {
		if (item.isEmpty()) return;
		switch (item._iMiscId) {
		case IMISC_HEAL:
		case IMISC_FULLHEAL:
			potionsHeal++;
			break;
		case IMISC_MANA:
		case IMISC_FULLMANA:
			potionsMana++;
			break;
		case IMISC_REJUV:
		case IMISC_FULLREJUV:
			potionsHeal++;
			potionsMana++;
			break;
		default:
			break;
		}
	};
	for (const Item &item : player.SpdList)
		countPotion(item);
	for (int i = 0; i < player._pNumInv; i++)
		countPotion(player.InvList[i]);
	w.key("potions").beginObject().field("heal", potionsHeal).field("mana", potionsMana).endObject();

	w.endObject();
}

void WriteQuests(JsonWriter &w)
{
	w.key("quests").beginArray();
	for (const Quest &quest : Quests) {
		if (quest._qactive == QUEST_NOTAVAIL || quest._qactive == QUEST_INVALID)
			continue;
		if (!quest.IsAvailable())
			continue;
		if (static_cast<size_t>(quest._qidx) >= QuestsData.size())
			continue;
		const QuestData &data = QuestsData[quest._qidx];
		w.beginObject();
		w.field("id", static_cast<int>(quest._qidx));
		w.field("name", std::string(_(data._qlstr.c_str())));
		w.field("state", static_cast<int>(quest._qactive));
		w.field("log", quest._qlog);
		w.field("level", static_cast<int>(quest._qlevel));
		w.endObject();
	}
	w.endArray();
}

void WriteEntities(JsonWriter &w, const Player &myPlayer)
{
	w.key("entities").beginObject();

	// Monsters currently in the player's line of sight.
	w.key("monsters").beginArray();
	for (size_t i = 0; i < ActiveMonsterCount; i++) {
		const Monster &monster = Monsters[ActiveMonsters[i]];
		if (monster.isInvalid || monster.hasNoLife())
			continue;
		const Point p = monster.position.tile;
		if (!IsCellVisible(p))
			continue;
		const int maxHp = std::max(1, monster.maxHitPoints.whole());
		w.beginArray()
		    .value(p.x)
		    .value(p.y)
		    .value(std::string(monster.name()))
		    .value(std::clamp(monster.hitPoints.whole() * 100 / maxHp, 0, 100))
		    .value(monster.isUnique())
		    .value(monster.isPlayerMinion())
		    .endArray();
	}
	w.endArray();

	// Town NPCs.
	w.key("npcs").beginArray();
	if (leveltype == DTYPE_TOWN) {
		for (const Towner &towner : Towners) {
			w.beginArray().value(towner.position.x).value(towner.position.y).value(std::string(towner.name)).endArray();
		}
	}
	w.endArray();

	// Items lying on explored ground.
	w.key("items").beginArray();
	for (uint8_t i = 0; i < ActiveItemCount; i++) {
		const Item &item = Items[ActiveItems[i]];
		const Point p = item.position;
		if (!InDungeonBounds(p) || !IsCellExplored(p.x, p.y))
			continue;
		w.beginArray().value(p.x).value(p.y).value(std::string(item.getName().str())).value(static_cast<int>(item._iMagical)).value(item._itype == ItemType::Gold).endArray();
	}
	w.endArray();

	// Interesting objects (doors, chests, shrines...) on explored tiles.
	w.key("objects").beginArray();
	for (int i = 0; i < ActiveObjectCount; i++) {
		const Object &object = Objects[ActiveObjects[i]];
		const Point p = object.position;
		if (!InDungeonBounds(p) || !IsCellExplored(p.x, p.y))
			continue;
		const bool isDoor = object.isDoor();
		if (!isDoor && !object.canInteractWith())
			continue; // already used / not interactive
		if (object.IsBarrel() || object.IsTrap())
			continue;
		w.beginArray()
		    .value(p.x)
		    .value(p.y)
		    .value(ObjectKind(object))
		    .value(std::string(object.name().str()))
		    .value(isDoor ? object._oVar4 != 0 : false) // door open?
		    .endArray();
	}
	w.endArray();

	// Stairs and other level transitions.
	w.key("triggers").beginArray();
	for (int i = 0; i < numtrigs; i++) {
		const TriggerStruct &trig = trigs[i];
		const Point p = trig.position;
		if (!InDungeonBounds(p) || !IsCellExplored(p.x, p.y))
			continue;
		w.beginArray().value(p.x).value(p.y).value(TriggerKind(trig)).value(trig._tlvl).endArray();
	}
	w.endArray();

	// Other players on the same level.
	w.key("players").beginArray();
	for (const Player &player : Players) {
		if (&player == &myPlayer || !player.plractive || !player.isOnActiveLevel())
			continue;
		w.beginArray().value(player.position.tile.x).value(player.position.tile.y).value(player._pName).endArray();
	}
	w.endArray();

	w.endObject();
}

void BuildState()
{
	const Player &myPlayer = *MyPlayer;
	JsonWriter w;
	w.beginObject();
	w.field("v", 1);
	w.field("inGame", true);
	w.field("seq", static_cast<int64_t>(++StateSequence));

	w.key("game").beginObject();
	w.field("location", GetLocationName());
	w.field("levelType", static_cast<int>(leveltype));
	w.field("level", static_cast<int>(currlevel));
	w.field("setLevel", setlevel);
	w.field("difficulty", static_cast<int>(sgGameInitInfo.nDifficulty));
	w.field("hellfire", gbIsHellfire);
	w.field("multiplayer", gbIsMultiplayer);
	w.field("mapVersion", static_cast<int64_t>(MapVersion));
	w.endObject();

	WritePlayer(w, myPlayer);
	WriteQuests(w);
	WriteEntities(w, myPlayer);

	w.endObject();
	Publish(StateJson, std::move(w.out));
}

/**
 * Map cells, one character per dungeon piece (MAXDUNX * MAXDUNY):
 *   '0' unexplored, '1' floor, '2' wall/solid
 */
void BuildMap(bool force)
{
	std::string cells(static_cast<size_t>(MAXDUNX) * MAXDUNY, '0');
	uint64_t hash = 1469598103934665603ULL;
	hash ^= static_cast<uint64_t>(currlevel) | (static_cast<uint64_t>(setlevel) << 8) | (static_cast<uint64_t>(setlvlnum) << 16) | (static_cast<uint64_t>(leveltype) << 24);
	for (int y = 0; y < MAXDUNY; y++) {
		for (int x = 0; x < MAXDUNX; x++) {
			if (!IsCellExplored(x, y))
				continue;
			const Point p { x, y };
			char c;
			if (dPiece[x][y] == 0 && leveltype != DTYPE_TOWN)
				c = '0';
			else
				c = IsTileSolid(p) ? '2' : '1';
			cells[static_cast<size_t>(y) * MAXDUNX + x] = c;
			hash = (hash ^ static_cast<uint64_t>(c + x * 131 + y * 7919)) * 1099511628211ULL;
		}
	}
	if (!force && hash == LastMapHash)
		return;
	LastMapHash = hash;
	MapVersion++;

	JsonWriter w;
	w.beginObject();
	w.field("v", 1);
	w.field("version", static_cast<int64_t>(MapVersion));
	w.field("levelType", static_cast<int>(leveltype));
	w.field("w", MAXDUNX);
	w.field("h", MAXDUNY);
	w.field("cells", cells);
	w.endObject();
	Publish(MapJson, std::move(w.out));
}

// ---------------------------------------------------------------------------
// HTTP server (server thread only)
// ---------------------------------------------------------------------------

class HttpSession : public std::enable_shared_from_this<HttpSession> {
public:
	HttpSession(asio::ip::tcp::socket socket, asio::io_context &ioc)
	    : socket_(std::move(socket))
	    , timer_(ioc)
	    , request_(MaxRequestSize)
	{
	}

	void Start()
	{
		auto self = shared_from_this();
		timer_.expires_after(std::chrono::seconds(5));
		timer_.async_wait([self](const asio::error_code &ec) {
			if (!ec) {
				asio::error_code ignored;
				self->socket_.close(ignored);
			}
		});
		asio::async_read_until(socket_, request_, "\r\n\r\n",
		    [self](const asio::error_code &ec, size_t /*bytes*/) {
			    if (ec) {
				    self->Close();
				    return;
			    }
			    self->HandleRequest();
		    });
	}

private:
	asio::ip::tcp::socket socket_;
	asio::steady_timer timer_;
	asio::streambuf request_;
	std::string header_;
	std::shared_ptr<const std::string> body_;

	void Close()
	{
		asio::error_code ignored;
		timer_.cancel();
		socket_.shutdown(asio::ip::tcp::socket::shutdown_both, ignored);
		socket_.close(ignored);
	}

	void HandleRequest()
	{
		std::string_view data(static_cast<const char *>(request_.data().data()), request_.size());
		const size_t lineEnd = data.find("\r\n");
		const std::string_view line = data.substr(0, lineEnd);
		const size_t sp1 = line.find(' ');
		const size_t sp2 = line.find(' ', sp1 + 1);
		if (sp1 == std::string_view::npos || sp2 == std::string_view::npos) {
			Respond(400, "text/plain", std::make_shared<const std::string>("Bad Request"));
			return;
		}
		const std::string_view method = line.substr(0, sp1);
		std::string_view path = line.substr(sp1 + 1, sp2 - sp1 - 1);
		const size_t query = path.find('?');
		if (query != std::string_view::npos)
			path = path.substr(0, query);

		if (method == "OPTIONS") {
			Respond(204, "text/plain", std::make_shared<const std::string>());
			return;
		}
		if (method != "GET") {
			Respond(405, "text/plain", std::make_shared<const std::string>("Method Not Allowed"));
			return;
		}
		if (path == "/api/state") {
			Respond(200, "application/json", Read(StateJson));
		} else if (path == "/api/map") {
			Respond(200, "application/json", Read(MapJson));
		} else if (path == "/api/ping" || path == "/") {
			Respond(200, "application/json", std::make_shared<const std::string>(R"({"ok":true,"name":"DevilutionX companion server","v":1})"));
		} else {
			Respond(404, "text/plain", std::make_shared<const std::string>("Not Found"));
		}
	}

	void Respond(int status, std::string_view contentType, std::shared_ptr<const std::string> body)
	{
		body_ = std::move(body);
		const char *statusText = "OK";
		switch (status) {
		case 204: statusText = "No Content"; break;
		case 400: statusText = "Bad Request"; break;
		case 404: statusText = "Not Found"; break;
		case 405: statusText = "Method Not Allowed"; break;
		default: break;
		}
		header_ = "HTTP/1.1 " + std::to_string(status) + " " + statusText + "\r\n";
		header_ += "Content-Type: ";
		header_ += contentType;
		header_ += "; charset=utf-8\r\n";
		header_ += "Content-Length: " + std::to_string(body_->size()) + "\r\n";
		header_ += "Cache-Control: no-store\r\n";
		header_ += "Access-Control-Allow-Origin: *\r\n";
		header_ += "Access-Control-Allow-Methods: GET, OPTIONS\r\n";
		header_ += "Connection: close\r\n\r\n";

		auto self = shared_from_this();
		const std::array<asio::const_buffer, 2> buffers { asio::buffer(header_), asio::buffer(*body_) };
		asio::async_write(socket_, buffers, [self](const asio::error_code & /*ec*/, size_t /*bytes*/) {
			self->Close();
		});
	}
};

class HttpServer {
public:
	bool Start(bool allowRemote, uint16_t port)
	{
		asio::error_code ec;
		const asio::ip::address address = allowRemote ? asio::ip::address(asio::ip::address_v4::any()) : asio::ip::address(asio::ip::address_v4::loopback());
		const asio::ip::tcp::endpoint endpoint(address, port);
		acceptor_.open(endpoint.protocol(), ec);
		if (!ec) acceptor_.set_option(asio::ip::tcp::acceptor::reuse_address(true), ec);
		if (!ec) acceptor_.bind(endpoint, ec);
		if (!ec) acceptor_.listen(asio::socket_base::max_listen_connections, ec);
		if (ec) {
			LogWarn("Companion server: unable to listen on port {}: {}", port, ec.message());
			asio::error_code ignored;
			acceptor_.close(ignored);
			return false;
		}
		DoAccept();
		thread_ = std::thread([this]() { ioc_.run(); });
		LogInfo("Companion server listening on {}:{}", address.to_string(), port);
		return true;
	}

	void Stop()
	{
		ioc_.stop();
		if (thread_.joinable())
			thread_.join();
		asio::error_code ignored;
		acceptor_.close(ignored);
	}

	~HttpServer()
	{
		Stop();
	}

private:
	asio::io_context ioc_;
	asio::ip::tcp::acceptor acceptor_ { ioc_ };
	std::thread thread_;

	void DoAccept()
	{
		acceptor_.async_accept([this](const asio::error_code &ec, asio::ip::tcp::socket socket) {
			if (!acceptor_.is_open())
				return;
			if (!ec)
				std::make_shared<HttpSession>(std::move(socket), ioc_)->Start();
			DoAccept();
		});
	}
};

std::unique_ptr<HttpServer> Server;

} // namespace

void Start()
{
	if (Server != nullptr)
		return;
	const NetworkOptions &options = GetOptions().Network;
	if (!*options.companionServer)
		return;
	auto server = std::make_unique<HttpServer>();
	if (server->Start(*options.companionAllowRemote, *options.companionPort))
		Server = std::move(server);
}

void Stop()
{
	Server = nullptr;
}

bool IsEnabled()
{
	return *GetOptions().Network.companionServer;
}

std::string GetStateJson()
{
	if (!IsEnabled())
		return {};
	return *Read(StateJson);
}

std::string GetMapJson()
{
	if (!IsEnabled())
		return {};
	return *Read(MapJson);
}

void UpdateGame()
{
	// Snapshots are also read in-process (GetStateJson/GetMapJson, used by the
	// Android second screen), so they are built even when the server is not running.
	if (!IsEnabled() || MyPlayer == nullptr)
		return;
	const uint64_t now = SDL_GetTicks();
	if (now - LastMapUpdate >= MapRefreshMs) {
		LastMapUpdate = now;
		BuildMap(false);
	}
	if (now - LastStateUpdate >= StateRefreshMs) {
		LastStateUpdate = now;
		BuildState();
	}
}

void EndGame()
{
	LastMapHash = 0;
	Publish(StateJson, R"({"v":1,"inGame":false})");
}

} // namespace companion
} // namespace devilution
