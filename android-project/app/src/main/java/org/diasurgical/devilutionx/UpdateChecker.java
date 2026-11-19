package org.diasurgical.devilutionx;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * AYN Thor edition: at launch, checks the latest GitHub release of the repository
 * this build comes from (BuildConfig.THOR_UPDATE_REPO) and offers to install it.
 *
 * Releases are tagged "thor-v<major>.<minor>.<patch>" and carry the APK as an
 * asset. The update is downloaded and handed to the system package installer,
 * which asks the user to confirm. If anything goes wrong, the release page is
 * opened in the browser instead.
 */
public final class UpdateChecker {
	private static final String TAG = "UpdateChecker";
	private static final String PREFS = "thor_updates";
	private static final String PREF_SKIPPED = "skipped_version";
	private static final String TAG_PREFIX = "thor-v";

	/** Only once per process: not every time the activity is restarted. */
	private static boolean checked;

	private final Activity activity;
	private final Handler mainHandler = new Handler(Looper.getMainLooper());

	private UpdateChecker(Activity activity) {
		this.activity = activity;
	}

	public static void checkOnce(Activity activity) {
		if (checked || BuildConfig.THOR_UPDATE_REPO.isEmpty())
			return;
		checked = true;
		new UpdateChecker(activity).checkInBackground();
	}

	private static final class Release {
		String version; // e.g. "1.2.0"
		String pageUrl;
		String apkUrl;
		long apkSize;
	}

	// ------------------------------------------------------------------------
	// Version check

	private void checkInBackground() {
		new Thread(() -> {
			try {
				Release release = fetchLatestRelease();
				if (release == null || compareVersions(release.version, BuildConfig.THOR_VERSION) <= 0)
					return;
				SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
				if (release.version.equals(prefs.getString(PREF_SKIPPED, "")))
					return;
				mainHandler.post(() -> offerUpdate(release));
			} catch (Exception e) {
				// No network, rate limit... not worth bothering the player.
				Log.i(TAG, "Update check failed", e);
			}
		}, "UpdateChecker").start();
	}

	private Release fetchLatestRelease() throws IOException, org.json.JSONException {
		URL url = new URL("https://api.github.com/repos/" + BuildConfig.THOR_UPDATE_REPO + "/releases/latest");
		HttpURLConnection connection = (HttpURLConnection) url.openConnection();
		try {
			connection.setConnectTimeout(8000);
			connection.setReadTimeout(8000);
			connection.setRequestProperty("Accept", "application/vnd.github+json");
			connection.setRequestProperty("User-Agent", "DevilutionX-Thor-Updater");
			if (connection.getResponseCode() != HttpURLConnection.HTTP_OK)
				return null;
			JSONObject json = new JSONObject(readAll(connection.getInputStream()));
			String tag = json.optString("tag_name", "");
			if (!tag.startsWith(TAG_PREFIX))
				return null;
			Release release = new Release();
			release.version = tag.substring(TAG_PREFIX.length());
			release.pageUrl = json.optString("html_url", "https://github.com/" + BuildConfig.THOR_UPDATE_REPO + "/releases/latest");
			JSONArray assets = json.optJSONArray("assets");
			if (assets != null) {
				for (int i = 0; i < assets.length(); i++) {
					JSONObject asset = assets.getJSONObject(i);
					if (asset.optString("name", "").endsWith(".apk")) {
						release.apkUrl = asset.optString("browser_download_url", null);
						release.apkSize = asset.optLong("size", -1);
						break;
					}
				}
			}
			return release;
		} finally {
			connection.disconnect();
		}
	}

	/** Compares "1.2.10" style versions. */
	static int compareVersions(String a, String b) {
		String[] pa = a.split("\\.");
		String[] pb = b.split("\\.");
		for (int i = 0; i < Math.max(pa.length, pb.length); i++) {
			int va = i < pa.length ? parseIntSafe(pa[i]) : 0;
			int vb = i < pb.length ? parseIntSafe(pb[i]) : 0;
			if (va != vb)
				return Integer.compare(va, vb);
		}
		return 0;
	}

	private static int parseIntSafe(String s) {
		try {
			return Integer.parseInt(s.replaceAll("[^0-9].*$", ""));
		} catch (NumberFormatException e) {
			return 0;
		}
	}

	private static String readAll(InputStream in) throws IOException {
		try (InputStream input = in) {
			ByteArrayOutputStream out = new ByteArrayOutputStream();
			byte[] buffer = new byte[8192];
			int n;
			while ((n = input.read(buffer)) > 0)
				out.write(buffer, 0, n);
			return new String(out.toByteArray(), StandardCharsets.UTF_8);
		}
	}

	// ------------------------------------------------------------------------
	// UI

	private boolean isGone() {
		return activity.isFinishing() || activity.isDestroyed();
	}

	private AlertDialog.Builder dialog() {
		return new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert);
	}

	private void offerUpdate(Release release) {
		if (isGone())
			return;
		dialog()
		    .setTitle(R.string.update_title)
		    .setMessage(activity.getString(R.string.update_message, release.version, BuildConfig.THOR_VERSION))
		    .setPositiveButton(R.string.update_install, (d, w) -> {
			    if (release.apkUrl != null)
				    download(release);
			    else
				    openPage(release);
		    })
		    .setNegativeButton(R.string.update_later, null)
		    .setNeutralButton(R.string.update_skip, (d, w) -> activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
		                                                         .edit()
		                                                         .putString(PREF_SKIPPED, release.version)
		                                                         .apply())
		    .show();
	}

	private void openPage(Release release) {
		if (isGone())
			return;
		try {
			activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(release.pageUrl)));
		} catch (RuntimeException e) {
			Log.e(TAG, "Unable to open " + release.pageUrl, e);
		}
	}

	private void download(Release release) {
		int pad = Math.round(20 * activity.getResources().getDisplayMetrics().density);
		LinearLayout layout = new LinearLayout(activity);
		layout.setOrientation(LinearLayout.VERTICAL);
		layout.setPadding(pad, pad / 2, pad, 0);
		TextView label = new TextView(activity);
		label.setText(activity.getString(R.string.update_downloading, release.version));
		ProgressBar bar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
		bar.setMax(100);
		bar.setIndeterminate(release.apkSize <= 0);
		layout.addView(label);
		layout.addView(bar);
		AlertDialog progress = dialog()
		                           .setTitle(R.string.update_title)
		                           .setView(layout)
		                           .setCancelable(false)
		                           .show();

		new Thread(() -> {
			boolean ok = false;
			try {
				ok = downloadAndInstall(release, percent -> mainHandler.post(() -> {
					bar.setIndeterminate(false);
					bar.setProgress(percent);
				}));
			} catch (Exception e) {
				Log.e(TAG, "Update download failed", e);
			}
			final boolean success = ok;
			mainHandler.post(() -> {
				if (!isGone())
					progress.dismiss();
				if (!success)
					showFailure(release);
			});
		}, "UpdateDownload").start();
	}

	private void showFailure(Release release) {
		if (isGone())
			return;
		dialog()
		    .setTitle(R.string.update_title)
		    .setMessage(R.string.update_failed)
		    .setPositiveButton(R.string.update_open_page, (d, w) -> openPage(release))
		    .setNegativeButton(R.string.update_later, null)
		    .show();
	}

	// ------------------------------------------------------------------------
	// Download + install

	private interface Progress {
		void onProgress(int percent);
	}

	/** Streams the APK into a PackageInstaller session and commits it. */
	private boolean downloadAndInstall(Release release, Progress progress) throws IOException {
		PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
		PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
		params.setAppPackageName(activity.getPackageName());
		int sessionId = installer.createSession(params);
		PackageInstaller.Session session = installer.openSession(sessionId);
		boolean committed = false;
		try {
			HttpURLConnection connection = (HttpURLConnection) new URL(release.apkUrl).openConnection();
			connection.setConnectTimeout(15000);
			connection.setReadTimeout(30000);
			connection.setInstanceFollowRedirects(true);
			connection.setRequestProperty("User-Agent", "DevilutionX-Thor-Updater");
			try {
				if (connection.getResponseCode() != HttpURLConnection.HTTP_OK)
					return false;
				long total = connection.getContentLength();
				if (total <= 0)
					total = release.apkSize;
				try (InputStream in = connection.getInputStream();
				     OutputStream out = session.openWrite("devilutionx-thor.apk", 0, total > 0 ? total : -1)) {
					byte[] buffer = new byte[64 * 1024];
					long done = 0;
					int lastPercent = -1;
					int n;
					while ((n = in.read(buffer)) > 0) {
						out.write(buffer, 0, n);
						done += n;
						if (total > 0) {
							int percent = (int) (done * 100 / total);
							if (percent != lastPercent) {
								lastPercent = percent;
								progress.onProgress(percent);
							}
						}
					}
					session.fsync(out);
				}
			} finally {
				connection.disconnect();
			}

			Intent intent = new Intent(activity, UpdateInstallReceiver.class);
			int flags = PendingIntent.FLAG_UPDATE_CURRENT;
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
				flags |= PendingIntent.FLAG_MUTABLE; // the installer adds its status extras
			PendingIntent pending = PendingIntent.getBroadcast(activity, sessionId, intent, flags);
			session.commit(pending.getIntentSender());
			committed = true;
			return true;
		} finally {
			if (!committed)
				session.abandon();
			session.close();
		}
	}
}
