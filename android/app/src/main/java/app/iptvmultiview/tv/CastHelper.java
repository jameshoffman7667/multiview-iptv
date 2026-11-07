package app.iptvmultiview.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.UiModeManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.res.Configuration;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;

import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;

import java.util.ArrayList;
import java.util.List;

/**
 * Casting from the app (phones and tablets with Google Play services). The page asks for a cast of the link the server
 * made (/cast/<token>.mp4); this picks a device and loads that link on the default media receiver.
 * Everything is wrapped so a device without Play services simply reports "not supported".
 */
class CastHelper {
    private final Activity activity;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Boolean supported;

    CastHelper(Activity activity) {
        this.activity = activity;
    }

    boolean supported() {
        if (supported != null) return supported;
        boolean ok = false;
        try {
            UiModeManager ui = (UiModeManager) activity.getSystemService(Context.UI_MODE_SERVICE);
            boolean tv = ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
            if (!tv) {
                CastContext.getSharedInstance(activity);
                ok = true;
            }
        } catch (Throwable e) {
            ok = false;
        }
        supported = ok;
        return ok;
    }

    private MediaRouteSelector selector() {
        return new MediaRouteSelector.Builder()
                .addControlCategory(CastMediaControlIntent.categoryForCast(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
                .build();
    }

    /** Casts the link: straight away when a device is already connected, otherwise after the person picks one. */
    void start(final String url, final String title) {
        if (!supported()) return;
        try {
            CastSession current = CastContext.getSharedInstance(activity).getSessionManager().getCurrentCastSession();
            if (current != null && current.isConnected()) {
                load(current, url, title);
                return;
            }
        } catch (Throwable ignored) {
            // fall through to the chooser
        }
        final MediaRouter router = MediaRouter.getInstance(activity);
        final MediaRouteSelector sel = selector();
        final MediaRouter.Callback cb = new MediaRouter.Callback() { };
        router.addCallback(sel, cb, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY | MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN);
        Toast.makeText(activity, "Looking for Cast devices...", Toast.LENGTH_SHORT).show();
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                final List<MediaRouter.RouteInfo> found = new ArrayList<MediaRouter.RouteInfo>();
                for (MediaRouter.RouteInfo r : router.getRoutes()) {
                    if (r.matchesSelector(sel) && r.isEnabled()) found.add(r);
                }
                if (found.isEmpty()) {
                    router.removeCallback(cb);
                    Toast.makeText(activity, "No Cast devices found on this network", Toast.LENGTH_LONG).show();
                    return;
                }
                String[] names = new String[found.size()];
                for (int i = 0; i < names.length; i++) names[i] = String.valueOf(found.get(i).getName());
                new AlertDialog.Builder(activity)
                        .setTitle("Cast to")
                        .setItems(names, new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface d, int which) {
                                router.selectRoute(found.get(which));
                                waitForSession(router, cb, url, title, 0);
                            }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            @Override
                            public void onCancel(DialogInterface d) {
                                router.removeCallback(cb);
                            }
                        })
                        .show();
            }
        }, 2000);
    }

    private void waitForSession(final MediaRouter router, final MediaRouter.Callback cb, final String url, final String title, final int tries) {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                CastSession s = null;
                try {
                    s = CastContext.getSharedInstance(activity).getSessionManager().getCurrentCastSession();
                } catch (Throwable ignored) {
                    // no session yet
                }
                if (s != null && s.isConnected()) {
                    router.removeCallback(cb);
                    load(s, url, title);
                } else if (tries >= 30) {
                    router.removeCallback(cb);
                    Toast.makeText(activity, "Could not connect to the Cast device", Toast.LENGTH_LONG).show();
                } else {
                    waitForSession(router, cb, url, title, tries + 1);
                }
            }
        }, 500);
    }

    private void load(CastSession session, String url, String title) {
        RemoteMediaClient client = session.getRemoteMediaClient();
        if (client == null) {
            Toast.makeText(activity, "The Cast device is not ready", Toast.LENGTH_LONG).show();
            return;
        }
        MediaMetadata md = new MediaMetadata(MediaMetadata.MEDIA_TYPE_GENERIC);
        md.putString(MediaMetadata.KEY_TITLE, title == null ? "" : title);
        MediaInfo info = new MediaInfo.Builder(url)
                .setStreamType(MediaInfo.STREAM_TYPE_LIVE)
                .setContentType("video/mp4")
                .setMetadata(md)
                .build();
        client.load(new MediaLoadRequestData.Builder().setMediaInfo(info).setAutoplay(true).build());
        Toast.makeText(activity, "Casting", Toast.LENGTH_SHORT).show();
    }

    void stop() {
        try {
            CastContext.getSharedInstance(activity).getSessionManager().endCurrentSession(true);
        } catch (Throwable ignored) {
            // nothing to stop
        }
    }
}
