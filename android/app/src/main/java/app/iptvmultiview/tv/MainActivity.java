package app.iptvmultiview.tv;

import android.app.Activity;
import android.Manifest;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.UiModeManager;
import android.app.PictureInPictureParams;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.util.Rational;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;

/**
 * A full-screen WebView around the IPTV Multiview web page served by your own server.
 * Arrow keys and OK reach the page unchanged, so the remote works exactly like a keyboard in the browser.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "iptv-multiview";
    private static final String KEY_SERVER = "server";

    private FrameLayout root;
    private WebView web;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private AlertDialog dialog;
    private WebChromeClient chrome;
    private boolean autoPip = false; // set by the page while something is playing
    private boolean inPip = false;
    private LocalPlayer local;   // local mode: native player behind the page
    private CastHelper cast;     // Google Cast sender (phones and tablets)

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT); // see-through while local mode plays behind the page (the page paints its own black)
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        cast = new CastHelper(this);
        cast.supported(); // checks Play services once, on the UI thread
        local = new LocalPlayer(this, root, new LocalPlayer.Events() {
            @Override
            public void onEvent(String name, String message) {
                tellPage("window.__mvLocal&&window.__mvLocal('" + js(name) + "','" + js(message) + "')");
            }
        });
        configure();
        immersive();

        String server = server();
        if (server.isEmpty()) {
            askServer(false);
        } else {
            web.loadUrl(server);
        }
    }

    // ------------------------------------------------------------------ settings

    private String server() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, "");
    }

    /** "192.168.1.20:1234" -> "http://192.168.1.20:1234/"; returns "" when it cannot be a web address. */
    static String normalise(String input) {
        String s = input == null ? "" : input.trim();
        if (s.isEmpty()) return "";
        if (!s.contains("://")) s = "http://" + s;
        Uri u = Uri.parse(s);
        String scheme = u.getScheme();
        if (u.getHost() == null || u.getHost().isEmpty()) return "";
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return "";
        String out = scheme.toLowerCase() + "://" + u.getEncodedAuthority() + (u.getEncodedPath() == null ? "" : u.getEncodedPath());
        return out.endsWith("/") ? out : out + "/";
    }

    private void configure() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " IPTVMultiviewTV/" + BuildConfig.APP_VERSION);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        web.addJavascriptInterface(new Bridge(), "MVApp");
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("mvapp".equals(u.getScheme())) {
                    if ("change".equals(u.getHost())) askServer(true);
                    else reload();
                    return true;
                }
                // stay on the configured server; anything else is not ours to show
                Uri base = Uri.parse(server());
                return base.getHost() != null && !base.getHost().equalsIgnoreCase(u.getHost());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError(String.valueOf(error.getDescription()));
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // the web view died (out of memory with many streams?): start it again instead of crashing
                recreate();
                return true;
            }
        });
        chrome = new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                web.setVisibility(View.VISIBLE);
                if (customCallback != null) customCallback.onCustomViewHidden();
                customCallback = null;
                web.requestFocus();
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.deny();
            }
        };
        web.setWebChromeClient(chrome);
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    private void reload() {
        String server = server();
        if (server.isEmpty()) askServer(false);
        else web.loadUrl(server);
    }

    private void showError(String why) {
        String safe = why.replace("&", "&amp;").replace("<", "&lt;");
        String html = "<html><body style='background:#0c0d10;color:#e6e8ee;font-family:sans-serif;padding:8vh 8vw;font-size:22px'>"
                + "<h2>Cannot reach your IPTV Multiview server</h2>"
                + "<p>" + safe + "</p>"
                + "<p>Address: " + server().replace("&", "&amp;").replace("<", "&lt;") + "</p>"
                + "<p><a href='mvapp://retry' style='color:#4da3ff'>Try again</a></p>"
                + "<p><a href='mvapp://change' style='color:#4da3ff'>Change server address</a></p>"
                + "</body></html>";
        web.loadDataWithBaseURL("http://localhost/", html, "text/html", "utf-8", null);
        web.requestFocus();
    }

    /** Asks for the address of the server (first run, or when changing it). */
    private void askServer(final boolean cancellable) {
        if (dialog != null && dialog.isShowing()) return;
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("192.168.1.20:1234");
        input.setText(server());
        input.setSelection(input.getText().length());
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("IPTV Multiview server address")
                .setMessage("Address of the machine running the Docker container, for example 192.168.1.20:1234")
                .setView(input)
                .setCancelable(cancellable)
                .setPositiveButton("Connect", null);
        if (cancellable) b.setNegativeButton("Cancel", null);
        dialog = b.create();
        dialog.setOnShowListener(new DialogInterface.OnShowListener() {
            @Override
            public void onShow(DialogInterface d) {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        String url = normalise(input.getText().toString());
                        if (url.isEmpty()) {
                            input.setError("Type an address like 192.168.1.20:1234");
                            return;
                        }
                        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, url).apply();
                        dialog.dismiss();
                        web.loadUrl(url);
                    }
                });
            }
        });
        dialog.show();
        immersive();
    }

    // ------------------------------------------------------------------ lifecycle and keys

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_BUTTON_START) {
            askServer(true);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            chrome.onHideCustomView();
        } else if (web.canGoBack()) {
            web.goBack(); // the page keeps one history entry per open window, so Back closes windows first
        } else {
            finish();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        immersive();
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        if (!inPip) web.onPause(); // keep playing inside the floating player
        super.onPause();
    }

    @Override
    protected void onStop() {
        if (inPip) web.onPause(); // the floating player was closed
        if (local != null) local.onHostStop();
        super.onStop();
    }

    // ------------------------------------------------------------------ mini player (picture-in-picture)

    /** Runs a line of JavaScript in the page (on the UI thread). */
    private void tellPage(final String script) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != null) web.evaluateJavascript(script, null);
            }
        });
    }

    private static String js(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ").replace("\r", " ");
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (local != null) local.onHostStart();
    }

    private boolean pipSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    private void enterPip() {
        if (!pipSupported() || isInPictureInPictureMode()) return;
        inPip = true; // before the pause callback, so the web view keeps running
        try {
            enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(new Rational(16, 9)).build());
        } catch (RuntimeException e) {
            inPip = false;
        }
    }

    /** Home / recent apps / another app: float the arrangement instead of stopping it. */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (autoPip && customView == null) enterPip();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        inPip = isInPictureInPictureMode;
        web.evaluateJavascript("window.__mvPip && window.__mvPip(" + isInPictureInPictureMode + ")", null);
        if (!isInPictureInPictureMode) {
            web.onResume();
            immersive();
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            immersive();
            web.requestFocus();
        }
    }

    @Override
    protected void onDestroy() {
        if (local != null) local.release();
        if (dialog != null) dialog.dismiss();
        root.removeAllViews();
        web.destroy();
        super.onDestroy();
    }

    // ---- downloads to this phone (P-32): Android's download manager saves into Movies/Multiview and shows its own notification.
    // The page keeps the queue and the limits (the server tracks each file through its ticket), this only hands one file over.
    private final ArrayList<String[]> pendingDownloads = new ArrayList<String[]>();
    private static final int REQ_STORAGE = 71;

    private boolean phoneLike() {
        UiModeManager ui = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        if (ui == null) return false;                                        // cannot tell: no buttons
        return ui.getCurrentModeType() != Configuration.UI_MODE_TYPE_TELEVISION
                && getPackageManager().hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN);
    }

    private static String safeName(String s) {
        String n = s == null ? "" : s.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (n.length() > 150) n = n.substring(n.length() - 150);
        return n.isEmpty() ? "download" : n;
    }

    private void startDownload(String url, String name) {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingDownloads.add(new String[]{url, name});
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
            return;
        }
        try {
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            String file = safeName(name);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) r.addRequestHeader("Cookie", cookie);
            r.addRequestHeader("User-Agent", web.getSettings().getUserAgentString());
            r.setTitle(file);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_MOVIES, "Multiview/" + file);
            dm.enqueue(r);
        } catch (RuntimeException e) {
            Toast.makeText(this, "Download could not start: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != REQ_STORAGE) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        ArrayList<String[]> todo = new ArrayList<String[]>(pendingDownloads);
        pendingDownloads.clear();
        if (!ok) {
            if (!todo.isEmpty()) Toast.makeText(this, "Downloads need permission to save files", Toast.LENGTH_LONG).show();
            return;
        }
        for (String[] d : todo) startDownload(d[0], d[1]);
    }

    private String downloadsJson() {
        JSONArray out = new JSONArray();
        DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
        android.database.Cursor c = null;
        try {
            c = dm.query(new DownloadManager.Query().setFilterByStatus(DownloadManager.STATUS_SUCCESSFUL));
            while (c != null && c.moveToNext()) {
                long id = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_ID));
                Uri u = dm.getUriForDownloadedFile(id);
                if (u == null) continue;
                try {
                    getContentResolver().openFileDescriptor(u, "r").close();     // the file may have been deleted since
                } catch (Exception gone) {
                    continue;
                }
                JSONObject o = new JSONObject();
                o.put("id", id);
                o.put("name", c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)));
                o.put("size", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)));
                o.put("time", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_LAST_MODIFIED_TIMESTAMP)));
                out.put(o);
            }
        } catch (Exception e) {
            return "[]";
        } finally {
            if (c != null) c.close();
        }
        return out.toString();
    }

    /** Called from the page (Settings > Change server address). */
    private class Bridge {
        // ---- downloads (phones and tablets only; the page shows no buttons when this says no)
        @JavascriptInterface
        public boolean downloadSupported() {
            return phoneLike();
        }

        @JavascriptInterface
        public void downloadStart(final String url, final String name) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startDownload(url, name);
                }
            });
        }

        @JavascriptInterface
        public String downloadList() {
            return downloadsJson();
        }

        @JavascriptInterface
        public void downloadPlay(final long id) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    Uri u = dm.getUriForDownloadedFile(id);
                    if (u == null) return;
                    float d = getResources().getDisplayMetrics().density;
                    local.play(u.toString(), "", 0, 0, root.getWidth() / d, root.getHeight() / d);
                }
            });
        }

        @JavascriptInterface
        public void downloadOpen(final long id) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    Uri u = dm.getUriForDownloadedFile(id);
                    if (u == null) return;
                    String mime = dm.getMimeTypeForDownloadedFile(id);
                    Intent view = new Intent(Intent.ACTION_VIEW);
                    view.setDataAndType(u, mime == null || mime.isEmpty() ? "video/*" : mime);
                    view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try {
                        startActivity(Intent.createChooser(view, "Open with"));
                    } catch (RuntimeException e) {
                        Toast.makeText(MainActivity.this, "No app can open this file", Toast.LENGTH_LONG).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void downloadDelete(final long id) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).remove(id);
                }
            });
        }

        @JavascriptInterface
        public void localSeek(final double seconds) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    local.seekBy(Math.round(seconds * 1000));
                }
            });
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.APP_VERSION;
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    askServer(true);
                }
            });
        }

        @JavascriptInterface
        public boolean canPip() {
            return pipSupported();
        }

        @JavascriptInterface
        public void enterPip() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.enterPip();
                }
            });
        }

        @JavascriptInterface
        public void setAutoPip(boolean on) {
            autoPip = on;
        }

        // ---- local mode (admins; the page decides when to use it)
        @JavascriptInterface
        public boolean localSupported() {
            return true;
        }

        @JavascriptInterface
        public void localPlay(final String url, final String userAgent, final double x, final double y, final double w, final double h) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    local.play(url, userAgent, x, y, w, h);
                }
            });
        }

        @JavascriptInterface
        public void localBounds(final double x, final double y, final double w, final double h) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    local.bounds(x, y, w, h);
                }
            });
        }

        @JavascriptInterface
        public void localPause(final boolean paused) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    local.setPaused(paused);
                }
            });
        }

        @JavascriptInterface
        public void localVolume(final double volume) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    local.setVolume((float) volume);
                }
            });
        }

        @JavascriptInterface
        public void localStop() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    local.release();
                }
            });
        }

        // ---- casting (Google Cast sender; phones and tablets)
        @JavascriptInterface
        public boolean castSupported() {
            return cast.supported();
        }

        @JavascriptInterface
        public void castStart(final String url, final String title) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    cast.start(url, title);
                }
            });
        }

        @JavascriptInterface
        public void castStop() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    cast.stop();
                }
            });
        }

        @JavascriptInterface
        public void toast(String text) {
            final String t = text;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, t, Toast.LENGTH_SHORT).show();
                }
            });
        }
    }
}
