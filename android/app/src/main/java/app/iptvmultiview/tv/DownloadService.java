package app.iptvmultiview.tv;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * Keeps the app alive while downloads run (a foreground service with a progress notification). It stops itself when nothing is
 * left to download; the downloads themselves live in {@link Downloader}.
 */
public class DownloadService extends Service {
    private static final String CHANNEL = "downloads";
    private static final int NOTIF = 31;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Downloader dl;
    private boolean running;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (dl.activeCount() == 0) {
                stopForeground(true);
                stopSelf();
                running = false;
                return;
            }
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIF, build());
            handler.postDelayed(this, 2000);
        }
    };

    private Notification build() {
        int n = dl.activeCount();
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        int pct = dl.percent();
        b.setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(n == 1 ? "Downloading 1 file" : "Downloading " + n + " files")
                .setContentText(pct + "%")
                .setProgress(100, pct, false)
                .setOngoing(true)
                .setOnlyAlertOnce(true);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        b.setContentIntent(android.app.PendingIntent.getActivity(this, 0, open, android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT));
        return b.build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        dl = Downloader.get(this);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW));
        }
        startForeground(NOTIF, build());
        if (!running) {
            running = true;
            handler.postDelayed(tick, 2000);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
