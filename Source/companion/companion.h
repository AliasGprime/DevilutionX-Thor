/**
 * @file companion.h
 *
 * Companion server: exposes a read-only snapshot of the game state (character,
 * automap, nearby monsters, quests...) as JSON over a tiny local HTTP server so
 * that a companion app (e.g. on the second screen of a dual-screen handheld)
 * can display it while playing.
 *
 * Endpoints (default http://127.0.0.1:8642):
 *   GET /api/state  -> character / game / entity snapshot
 *   GET /api/map    -> explored map cells of the current level
 *   GET /api/ping   -> {"ok":true}
 */
#pragma once

namespace devilution {
namespace companion {

#ifdef COMPANION_SERVER
/** @brief Starts the HTTP server thread (no-op if disabled in options). */
void Start();
/** @brief Stops the HTTP server thread. */
void Stop();
/** @brief Called from the main game loop, refreshes the snapshot periodically. */
void UpdateGame();
/** @brief Called when the player leaves the game (back to the menus). */
void EndGame();
#else
inline void Start()
{
}
inline void Stop()
{
}
inline void UpdateGame()
{
}
inline void EndGame()
{
}
#endif

} // namespace companion
} // namespace devilution
