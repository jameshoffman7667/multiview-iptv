package app.iptvmultiview.tv;

import android.app.Activity;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;

/**
 * Local mode: one native video (ExoPlayer) that pulls the provider's stream directly, drawn on a SurfaceView behind the
 * transparent web page at the rectangle the page gives for the selected screen. Errors are reported to the page, which
 * then plays that screen through the server again.
 */
class LocalPlayer {
    interface Events {
        void onEvent(String name, String message);
    }

    private final Activity activity;
    private final FrameLayout root;
    private final Events events;
    private ExoPlayer player;
    private SurfaceView surface;
    private float density = 1f;
    private double bx, by, bw, bh;      // the screen's rectangle, in CSS pixels
    private int videoW, videoH;
    private boolean paused;
    private float volume = 1f;

    LocalPlayer(Activity activity, FrameLayout root, Events events) {
        this.activity = activity;
        this.root = root;
        this.events = events;
        this.density = activity.getResources().getDisplayMetrics().density;
    }

    void play(String url, String userAgent, double x, double y, double w, double h) {
        release();
        bx = x; by = y; bw = w; bh = h;
        videoW = 0; videoH = 0;
        paused = false;
        surface = new SurfaceView(activity);
        root.addView(surface, 0, new FrameLayout.LayoutParams(1, 1));
        layout();
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(15000);
        if (userAgent != null && !userAgent.isEmpty()) http.setUserAgent(userAgent);
        player = new ExoPlayer.Builder(activity).build();
        player.setVideoSurfaceView(surface);
        player.setVolume(volume);
        player.addListener(new Player.Listener() {
            @Override
            public void onVideoSizeChanged(VideoSize size) {
                videoW = size.width;
                videoH = size.height;
                if (size.pixelWidthHeightRatio > 0f && size.pixelWidthHeightRatio != 1f) {
                    videoW = Math.round(size.width * size.pixelWidthHeightRatio);
                }
                layout();
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) events.onEvent("playing", "");
                else if (state == Player.STATE_ENDED) events.onEvent("ended", "the stream ended");
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                events.onEvent("error", error.getErrorCodeName());
            }
        });
        player.setMediaSource(new ProgressiveMediaSource.Factory(http).createMediaSource(MediaItem.fromUri(url)));
        player.setPlayWhenReady(true);
        player.prepare();
    }

    void bounds(double x, double y, double w, double h) {
        bx = x; by = y; bw = w; bh = h;
        layout();
    }

    /** Fits the picture inside the screen's rectangle without stretching it (black bars like the page's Fit mode). */
    private void layout() {
        if (surface == null) return;
        double left = bx * density;
        double top = by * density;
        double width = Math.max(1, bw * density);
        double height = Math.max(1, bh * density);
        if (videoW > 0 && videoH > 0) {
            double scale = Math.min(width / videoW, height / videoH);
            double fw = videoW * scale;
            double fh = videoH * scale;
            left += (width - fw) / 2;
            top += (height - fh) / 2;
            width = fw;
            height = fh;
        }
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.max(1, (int) Math.round(width)), Math.max(1, (int) Math.round(height)));
        lp.leftMargin = (int) Math.round(left);
        lp.topMargin = (int) Math.round(top);
        surface.setLayoutParams(lp);
    }

    void setPaused(boolean p) {
        paused = p;
        if (player != null) player.setPlayWhenReady(!p);
    }

    void setVolume(float v) {
        volume = Math.max(0f, Math.min(1f, v));
        if (player != null) player.setVolume(volume);
    }

    /** The app went to the background (not into the floating player): stop pulling the stream. */
    void onHostStop() {
        if (player != null) player.setPlayWhenReady(false);
    }

    void onHostStart() {
        if (player != null) player.setPlayWhenReady(!paused);
    }

    boolean active() {
        return player != null;
    }

    void release() {
        if (player != null) {
            try {
                player.release();
            } catch (RuntimeException ignored) {
                // already released
            }
            player = null;
        }
        if (surface != null) {
            ViewGroup parent = (ViewGroup) surface.getParent();
            if (parent != null) parent.removeView(surface);
            surface = null;
        }
    }
}
