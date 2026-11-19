package org.diasurgical.devilutionx;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;
import android.widget.Toast;

/**
 * Receives the status of an update installed by {@link UpdateChecker}: shows the
 * system confirmation screen, or reports a failure.
 */
public class UpdateInstallReceiver extends BroadcastReceiver {
	private static final String TAG = "UpdateInstallReceiver";

	@Override
	public void onReceive(Context context, Intent intent) {
		int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
		switch (status) {
		case PackageInstaller.STATUS_PENDING_USER_ACTION: {
			Intent confirm = getConfirmIntent(intent);
			if (confirm != null) {
				confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
				context.startActivity(confirm);
			}
			break;
		}
		case PackageInstaller.STATUS_SUCCESS:
			// The app is replaced (and restarted by the user), nothing to do.
			break;
		case PackageInstaller.STATUS_FAILURE_ABORTED:
			// Cancelled by the user.
			break;
		default: {
			String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
			Log.e(TAG, "Update failed: " + status + " " + message);
			Toast.makeText(context, context.getString(R.string.update_failed), Toast.LENGTH_LONG).show();
			break;
		}
		}
	}

	@SuppressWarnings("deprecation")
	private static Intent getConfirmIntent(Intent intent) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
			return intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
		return intent.getParcelableExtra(Intent.EXTRA_INTENT);
	}
}
