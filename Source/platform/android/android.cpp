#include "companion/companion.h"
#include "init.hpp"
#include "mpq/mpq_reader.hpp"

#include <string>

#include <jni.h>

namespace devilution {
namespace {

jbyteArray ToByteArray(JNIEnv *env, const std::string &str)
{
	jbyteArray array = env->NewByteArray(static_cast<jsize>(str.size()));
	if (array != nullptr && !str.empty())
		env->SetByteArrayRegion(array, 0, static_cast<jsize>(str.size()), reinterpret_cast<const jbyte *>(str.data()));
	return array;
}

bool AreExtraFontsOutOfDateForMpqPath(const char *mpqPath)
{
	std::expected<MpqArchive, std::string> archive = MpqArchive::Open(mpqPath);
	return archive.has_value() && AreExtraFontsOutOfDate(*archive);
}

} // namespace
} // namespace devilution

extern "C" {
JNIEXPORT jboolean JNICALL Java_org_diasurgical_devilutionx_DevilutionXSDLActivity_areFontsOutOfDate(JNIEnv *env, jclass cls, jstring fonts_mpq)
{
	const char *mpqPath = env->GetStringUTFChars(fonts_mpq, nullptr);
	bool outOfDate = devilution::AreExtraFontsOutOfDateForMpqPath(mpqPath);
	env->ReleaseStringUTFChars(fonts_mpq, mpqPath);
	return outOfDate;
}

// Second screen (AYN Thor): game state snapshots as UTF-8 JSON, see Source/companion.
JNIEXPORT jbyteArray JNICALL Java_org_diasurgical_devilutionx_SecondScreen_nativeGetState(JNIEnv *env, jclass cls)
{
	return devilution::ToByteArray(env, devilution::companion::GetStateJson());
}

JNIEXPORT jbyteArray JNICALL Java_org_diasurgical_devilutionx_SecondScreen_nativeGetMap(JNIEnv *env, jclass cls)
{
	return devilution::ToByteArray(env, devilution::companion::GetMapJson());
}
}
