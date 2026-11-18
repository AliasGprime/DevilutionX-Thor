package org.diasurgical.devilutionx;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;

import java.lang.ref.WeakReference;

/**
 * Fallback used by {@link SecondScreen} when the system does not allow a
 * Presentation window on the second display: the same companion UI, as an
 * activity launched directly on that display.
 */
public class CompanionActivity extends Activity {
	private static WeakReference<CompanionActivity> instance = new WeakReference<>(null);

	private WebView webView;

	static boolean isRunning() {
		CompanionActivity activity = instance.get();
		return activity != null && !activity.isFinishing();
	}

	static void finishInstance() {
		CompanionActivity activity = instance.get();
		if (activity != null)
			activity.finish();
	}

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		// Must be set before the window gets focus for the first time.
		SecondScreen.configureWindow(getWindow());
		super.onCreate(savedInstanceState);
		instance = new WeakReference<>(this);
		webView = SecondScreen.createWebView(this);
		setContentView(webView);
	}

	@Override
	public void onWindowFocusChanged(boolean hasFocus) {
		super.onWindowFocusChanged(hasFocus);
		SecondScreen.configureWindow(getWindow());
	}

	@Override
	protected void onDestroy() {
		if (instance.get() == this) {
			instance = new WeakReference<>(null);
			// Bring the control panel back on the main screen.
			SecondScreen.setActive(false);
		}
		if (webView != null)
			webView.destroy();
		super.onDestroy();
	}
}
