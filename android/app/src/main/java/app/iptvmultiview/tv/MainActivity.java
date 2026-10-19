package app.iptvmultiview.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PictureInPictureParams;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
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
        super.onStop();
    }

    // ------------------------------------------------------------------ mini player (picture-in-picture)

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
        if (dialog != null) dialog.dismiss();
        root.removeAllViews();
        web.destroy();
        super.onDestroy();
    }

    /** Called from the page (Settings > Change server address). */
    private class Bridge {
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
