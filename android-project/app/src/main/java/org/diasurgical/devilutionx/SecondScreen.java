package org.diasurgical.devilutionx;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.ActivityOptions;
import android.app.Presentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Display;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * Shows the companion UI (map, character, items, quests) on the second screen of
 * dual-screen devices such as the AYN Thor.
 *
 * The UI lives in assets/companion and reads the game state from the companion
 * server embedded in the native game (http://127.0.0.1:8642, see Source/companion).
 *
 * The preferred way is an android.app.Presentation (a window owned by the game
 * activity, shown on the other display). If the system refuses it, a separate
 * activity is launched on that display instead.
 *
 * In both cases the window is not focusable: touching the second screen must
 * not take the input focus (and the gamepad) away from the game.
 */
public class SecondScreen implements DisplayManager.DisplayListener {
	private static final String TAG = "SecondScreen";
	static final String UI_URL = "file:///android_asset/companion/index.html?embedded=1";

	private final Activity activity;
	private final DisplayManager displayManager;
	private final Handler handler = new Handler(Looper.getMainLooper());
	private CompanionPresentation presentation;
	private int fallbackDisplayId = Display.INVALID_DISPLAY;
	private boolean started;

	public SecondScreen(Activity activity) {
		this.activity = activity;
		this.displayManager = (DisplayManager) activity.getSystemService(Context.DISPLAY_SERVICE);
	}

	public void start() {
		if (started || displayManager == null)
			return;
		started = true;
		displayManager.registerDisplayListener(this, handler);
		update();
	}

	public void stop() {
		if (!started)
			return;
		started = false;
		displayManager.unregisterDisplayListener(this);
		dismissPresentation();
		CompanionActivity.finishInstance();
		fallbackDisplayId = Display.INVALID_DISPLAY;
	}

	@Override
	public void onDisplayAdded(int displayId) {
		if (started) update();
	}

	@Override
	public void onDisplayRemoved(int displayId) {
		if (started) update();
	}

	@Override
	public void onDisplayChanged(int displayId) {
		if (started) update();
	}

	private void update() {
		Display target = findSecondDisplay();
		if (target == null) {
			dismissPresentation();
			return;
		}
		int targetId = target.getDisplayId();
		if (presentation != null && presentation.getDisplay().getDisplayId() == targetId)
			return;
		if (presentation == null && fallbackDisplayId == targetId && CompanionActivity.isRunning())
			return;

		dismissPresentation();
		try {
			presentation = new CompanionPresentation(activity, target);
			presentation.show();
			Log.i(TAG, "Companion shown as a presentation on display " + targetId);
		} catch (WindowManager.InvalidDisplayException | WindowManager.BadTokenException | SecurityException e) {
			Log.w(TAG, "Presentation refused on display " + targetId + ", launching an activity instead", e);
			presentation = null;
			launchActivity(targetId);
		}
	}

	/** Any display other than the one the game runs on (built-in second screen first). */
	private Display findSecondDisplay() {
		@SuppressWarnings("deprecation")
		int gameDisplayId = activity.getWindowManager().getDefaultDisplay().getDisplayId();
		for (Display display : displayManager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION)) {
			if (display.getDisplayId() != gameDisplayId)
				return display;
		}
		for (Display display : displayManager.getDisplays()) {
			if (display.getDisplayId() != gameDisplayId && (display.getFlags() & Display.FLAG_PRIVATE) == 0)
				return display;
		}
		return null;
	}

	private void dismissPresentation() {
		if (presentation != null) {
			presentation.dismiss();
			presentation = null;
		}
	}

	private void launchActivity(int displayId) {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O)
			return;
		try {
			Intent intent = new Intent(activity, CompanionActivity.class);
			intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_MULTIPLE_TASK);
			ActivityOptions options = ActivityOptions.makeBasic();
			options.setLaunchDisplayId(displayId);
			activity.startActivity(intent, options.toBundle());
			fallbackDisplayId = displayId;
		} catch (RuntimeException e) {
			Log.e(TAG, "Unable to show the companion on display " + displayId, e);
		}
	}

	// ------------------------------------------------------------------------

	@SuppressLint("SetJavaScriptEnabled")
	static WebView createWebView(Context context) {
		WebView webView = new WebView(context);
		webView.setBackgroundColor(Color.rgb(11, 9, 7));
		webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
		WebSettings settings = webView.getSettings();
		settings.setJavaScriptEnabled(true);
		settings.setDomStorageEnabled(true);
		settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
		settings.setAllowContentAccess(false);
		webView.loadUrl(UI_URL);
		return webView;
	}

	/** Not focusable, screen kept on, system bars hidden. */
	static void configureWindow(Window window) {
		if (window == null)
			return;
		window.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
		    | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
		    | WindowManager.LayoutParams.FLAG_FULLSCREEN);
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
			window.setDecorFitsSystemWindows(false);
			WindowInsetsController controller = window.getInsetsController();
			if (controller != null) {
				controller.hide(WindowInsets.Type.systemBars());
				controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
			}
		} else {
			window.getDecorView().setSystemUiVisibility(
			    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
			        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
			        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
			        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
			        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
			        | View.SYSTEM_UI_FLAG_FULLSCREEN);
		}
	}

	static final class CompanionPresentation extends Presentation {
		private WebView webView;

		CompanionPresentation(Context outerContext, Display display) {
			super(outerContext, display);
		}

		@Override
		protected void onCreate(Bundle savedInstanceState) {
			super.onCreate(savedInstanceState);
			webView = createWebView(getContext());
			setContentView(webView);
			configureWindow(getWindow());
		}

		@Override
		protected void onStop() {
			if (webView != null) {
				webView.destroy();
				webView = null;
			}
			super.onStop();
		}
	}
}
