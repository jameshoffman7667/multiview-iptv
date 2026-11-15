package app.iptvmultiview.tv;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The app's own download manager (P-35). Android's DownloadManager paused whenever a connection dropped and could not get a fresh
 * ticket from the server, so downloads here run in the app: each file is fetched with HTTP Range requests into a part file (so a
 * dropped connection, a network change or a restart continues where it stopped), retried with a back-off, queued up to the
 * "Max concurrent downloads" setting, optionally Wi-Fi only, and moved into the public Movies/Multiview folder when complete.
 * Every request goes through the server's /api/dl/ticket and /vod routes, so the server's cap and "keep one provider connection
 * free for watching" rules apply exactly as they do in the browser. The state lives in downloads-state.json so a restart resumes it.
 */
class Downloader {
    private static Downloader instance;

    static synchronized Downloader get(Context ctx) {
        if (instance == null) instance = new Downloader(ctx.getApplicationContext());
        return instance;
    }

    static class Item {
        String id, origin, p, sid, ext, name, state, reason = "", uri = "", job = "";
        long done, total;
        long speed;                     // bytes per second, about
        boolean stop;                   // asked to pause or cancel: the worker leaves
        boolean cancel;
        int fails;                      // attempts in a row without progress
        Thread worker;
    }

    private final Context ctx;
    private final List<Item> items = new ArrayList<Item>();
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final File stateFile;
    private int max = 3;
    private boolean wifiOnly = false;

    private Downloader(Context ctx) {
        this.ctx = ctx;
        this.stateFile = new File(ctx.getFilesDir(), "downloads-state.json");
        load();
    }

    // ---- page-facing API (called from the bridge) ----

    synchronized void config(int maxConcurrent, boolean wifi) {
        max = Math.max(1, Math.min(6, maxConcurrent));
        wifiOnly = wifi;
        pump();
    }

    synchronized void add(String origin, JSONArray list) throws Exception {
        for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.getJSONObject(i);
            Item it = new Item();
            it.id = Long.toHexString(System.nanoTime()) + Integer.toHexString(i);
            it.origin = origin;
            it.p = o.getString("p");
            it.sid = o.getString("sid");
            it.ext = o.optString("ext", "mp4");
            it.name = o.optString("name", it.sid);
            it.state = "queued";
            items.add(it);
        }
        save();
        pump();
    }

    synchronized void pause(String id) {
        Item it = find(id);
        if (it == null) return;
        if (it.worker != null) it.stop = true;
        if (!it.state.equals("done") && !it.state.equals("failed")) it.state = "paused";
        it.reason = "";
        save();
        pump();
    }

    synchronized void resume(String id) {
        Item it = find(id);
        if (it == null || !(it.state.equals("paused") || it.state.equals("failed"))) return;
        it.state = "queued";
        it.reason = "";
        it.fails = 0;
        it.stop = false;
        save();
        pump();
    }

    /** Cancel a queued, running, paused or failed download (its part file goes), or remove a finished one from the list and the phone. */
    synchronized void remove(String id) {
        Item it = find(id);
        if (it == null) return;
        it.cancel = true;
        it.stop = true;
        items.remove(it);
        if (it.state.equals("done")) deleteSaved(it);
        part(it).delete();
        save();
        pump();
    }

    synchronized String statusJson() {
        JSONArray out = new JSONArray();
        try {
            for (Item it : items) {
                JSONObject o = new JSONObject();
                o.put("id", it.id);
                o.put("name", it.name);
                o.put("state", it.state);
                o.put("reason", it.reason);
                o.put("done", it.done);
                o.put("total", it.total);
                o.put("speed", it.speed);
                out.put(o);
            }
        } catch (Exception ignored) {
            // JSON of plain values cannot fail
        }
        return out.toString();
    }

    synchronized Uri savedUri(String id) {
        Item it = find(id);
        if (it == null || !it.state.equals("done") || it.uri.isEmpty()) return null;
        return Uri.parse(it.uri);
    }

    synchronized int activeCount() {
        int n = 0;
        for (Item it : items) if (it.state.equals("queued") || it.state.equals("running") || it.state.equals("waiting")) n++;
        return n;
    }

    synchronized int percent() {
        long d = 0, t = 0;
        for (Item it : items) {
            if (it.state.equals("running") || it.state.equals("waiting") || it.state.equals("queued")) { d += it.done; t += it.total; }
        }
        return t > 0 ? (int) (100 * d / t) : 0;
    }

    // ---- scheduling ----

    private Item find(String id) {
        for (Item it : items) if (it.id.equals(id)) return it;
        return null;
    }

    private int workers() {
        int n = 0;
        for (Item it : items) if (it.worker != null) n++;
        return n;
    }

    private void pump() {
        for (Item it : new ArrayList<Item>(items)) {
            if (workers() >= max) break;
            if (it.state.equals("queued") && it.worker == null) startWorker(it);
        }
        if (activeCount() > 0) {
            try {
                Intent i = new Intent(ctx, DownloadService.class);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i); else ctx.startService(i);
            } catch (RuntimeException ignored) {
                // the app is in the background and may not start a service; the downloads still run while the process lives
            }
        }
    }

    private void startWorker(final Item it) {
        it.stop = false;
        it.state = "running";
        it.reason = "";
        it.worker = new Thread() {
            @Override
            public void run() {
                try {
                    work(it);
                } catch (Throwable t) {
                    finish(it, "failed", "Stopped: " + t.getClass().getSimpleName());
                }
                synchronized (Downloader.this) {
                    it.worker = null;
                    it.speed = 0;
                    pump();
                }
            }
        };
        pool.execute(it.worker);
    }

    private synchronized void finish(Item it, String state, String reason) {
        if (it.cancel) return;
        if (it.state.equals("paused") && state.equals("failed")) return;
        it.state = state;
        it.reason = reason;
        it.speed = 0;
        save();
    }

    private synchronized void set(Item it, String state, String reason) {
        if (it.stop || it.cancel) return;
        it.state = state;
        it.reason = reason;
    }

    // ---- one download ----

    private File part(Item it) {
        File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_MOVIES);
        if (dir == null) dir = ctx.getFilesDir();
        File d = new File(dir, "part");
        d.mkdirs();
        return new File(d, it.id + ".part");
    }

    private static String safe(String s) {
        String n = s == null ? "" : s.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (n.length() > 150) n = n.substring(n.length() - 150);
        return n.isEmpty() ? "download" : n;
    }

    private boolean online() {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return true;
        android.net.Network n = cm.getActiveNetwork();
        if (n == null) return false;
        NetworkCapabilities c = cm.getNetworkCapabilities(n);
        return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private boolean onWifiOrWired() {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return true;
        android.net.Network n = cm.getActiveNetwork();
        if (n == null) return false;
        NetworkCapabilities c = cm.getNetworkCapabilities(n);
        return c != null && (c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
    }

    /** Sleeps in small steps so a pause or cancel is noticed quickly. Returns false when the item was stopped. */
    private boolean nap(Item it, long ms) {
        long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            if (it.stop || it.cancel) return false;
            try {
                Thread.sleep(250);
            } catch (InterruptedException e) {
                return false;
            }
        }
        return !(it.stop || it.cancel);
    }

    private void work(Item it) throws Exception {
        File part = part(it);
        synchronized (this) { it.done = part.exists() ? part.length() : 0; }
        while (!it.stop && !it.cancel) {
            if (!online()) { set(it, "waiting", "Waiting for a network connection"); if (!nap(it, 3000)) return; continue; }
            if (wifiOnly && !onWifiOrWired()) { set(it, "waiting", "Waiting for Wi-Fi (Wi-Fi only is on)"); if (!nap(it, 3000)) return; continue; }
            if (it.fails > 40) { finish(it, "failed", "Gave up after repeated errors - tap Retry"); return; }
            // a ticket from the server: it applies the server cap and keeps one provider connection free for watching
            if (it.job.isEmpty()) {
                JSONObject t;
                try {
                    t = ticket(it);
                } catch (IOException e) {
                    it.fails++;
                    set(it, "waiting", "Cannot reach the server, retrying");
                    if (!nap(it, backoff(it.fails))) return;
                    continue;
                }
                if (t == null) return;                                   // refused for good (already marked failed)
                if (t.optBoolean("wait", false)) {
                    set(it, "waiting", "Waiting: " + t.optString("reason", "the server asked to wait"));
                    if (!nap(it, 6000)) return;
                    continue;
                }
                it.job = t.optString("url", "");
            }
            int code;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(it.origin + it.job).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setInstanceFollowRedirects(true);
                String cookie = CookieManager.getInstance().getCookie(it.origin);
                if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
                if (it.done > 0) c.setRequestProperty("Range", "bytes=" + it.done + "-");
                code = c.getResponseCode();
                if (code == 410) { it.job = ""; c.disconnect(); continue; }                    // the ticket went stale: ask for a new one
                if (code == 401 || code == 403) { finish(it, "failed", code == 401 ? "Signed out - sign in again, then tap Retry" : "Downloads are switched off for this login"); c.disconnect(); return; }
                if (code == 404) { finish(it, "failed", "The provider no longer has this file"); c.disconnect(); return; }
                if (code == 503 || code == 502) {
                    set(it, "waiting", "The provider is busy or not reachable, retrying");
                    c.disconnect();
                    it.job = "";
                    if (!nap(it, 10000)) return;
                    continue;
                }
                if (code != 200 && code != 206) throw new IOException("HTTP " + code);
                boolean append = code == 206 && it.done > 0;
                long len = c.getContentLengthLong();
                synchronized (this) {
                    if (!append) it.done = 0;                                                 // the server sent the whole file again
                    if (code == 206) {
                        String cr = c.getHeaderField("Content-Range");                        // bytes 100-999/1000
                        int slash = cr == null ? -1 : cr.lastIndexOf('/');
                        if (slash > 0) { try { it.total = Long.parseLong(cr.substring(slash + 1).trim()); } catch (NumberFormatException ignored) { /* unknown */ } }
                    } else if (len > 0) {
                        it.total = len;
                    }
                }
                set(it, "running", "");
                InputStream in = c.getInputStream();
                OutputStream out = new FileOutputStream(part, append);
                try {
                    byte[] buf = new byte[64 * 1024];
                    long tick = System.currentTimeMillis(), tickBytes = it.done;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (it.stop || it.cancel) return;
                        out.write(buf, 0, n);
                        it.done += n;
                        it.fails = 0;
                        long now = System.currentTimeMillis();
                        if (now - tick >= 1000) { it.speed = (it.done - tickBytes) * 1000 / (now - tick); tick = now; tickBytes = it.done; }
                    }
                } finally {
                    out.close();
                    in.close();
                }
                if (it.total > 0 && it.done < it.total) throw new IOException("connection ended early");
                complete(it, part);
                return;
            } catch (IOException e) {
                if (it.stop || it.cancel) return;
                it.fails++;
                set(it, "waiting", "Connection lost, retrying (" + (e.getMessage() == null ? "error" : e.getMessage()) + ")");
                if (!nap(it, backoff(it.fails))) return;
            } finally {
                if (c != null) c.disconnect();
            }
        }
    }

    private static long backoff(int fails) {
        return Math.min(30000, 2000L * Math.max(1, fails));
    }

    /** POST /api/dl/ticket with the app's login cookie. Returns null (and marks the item failed) when the server refuses for good. */
    private JSONObject ticket(Item it) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(it.origin + "/api/dl/ticket").openConnection();
        try {
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            String cookie = CookieManager.getInstance().getCookie(it.origin);
            if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
            JSONObject body = new JSONObject();
            try {
                body.put("p", it.p);
                body.put("sid", it.sid);
                body.put("ext", it.ext);
                body.put("name", it.name);
            } catch (org.json.JSONException e) {
                throw new IOException(e);
            }
            OutputStream o = c.getOutputStream();
            o.write(body.toString().getBytes("UTF-8"));
            o.close();
            int code = c.getResponseCode();
            if (code == 401) { finish(it, "failed", "Signed out - sign in again, then tap Retry"); return null; }
            if (code == 403) { finish(it, "failed", "Downloads are switched off for this login"); return null; }
            if (code >= 400 && code < 500) { finish(it, "failed", "The server refused this download (HTTP " + code + ")"); return null; }
            if (code != 200) throw new IOException("HTTP " + code);
            InputStream in = c.getInputStream();
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            in.close();
            try {
                return new JSONObject(bo.toString("UTF-8"));
            } catch (org.json.JSONException e) {
                throw new IOException("bad answer");
            }
        } finally {
            c.disconnect();
        }
    }

    // ---- saving into Movies/Multiview ----

    private void complete(Item it, File part) {
        set(it, "running", "Saving to Movies/Multiview");
        String file = safe(it.name) + "." + safe(it.ext);
        try {
            Uri saved = publish(part, file);
            synchronized (this) {
                it.uri = saved.toString();
                it.state = "done";
                it.reason = "";
                it.speed = 0;
                if (it.total <= 0) it.total = it.done;
                save();
            }
            part.delete();
        } catch (Exception e) {
            finish(it, "failed", "Could not save the file: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()) + " (tap Retry)");
        }
    }

    private Uri publish(File part, String file) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver r = ctx.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, file);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime(file));
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/Multiview");
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri u = r.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, v);
            if (u == null) throw new IOException("the phone refused the new file");
            try {
                OutputStream o = r.openOutputStream(u);
                if (o == null) throw new IOException("cannot write the file");
                copy(part, o);
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                r.update(u, done, null, null);
            } catch (IOException e) {
                r.delete(u, null, null);
                throw e;
            }
            return u;
        }
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "Multiview");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("no storage permission or no space");
        File dest = new File(dir, file);
        for (int i = 1; dest.exists() && i < 1000; i++) {
            int dot = file.lastIndexOf('.');
            dest = new File(dir, dot > 0 ? file.substring(0, dot) + " (" + i + ")" + file.substring(dot) : file + " (" + i + ")");
        }
        copy(part, new FileOutputStream(dest));
        return Uri.fromFile(dest);
    }

    private static void copy(File from, OutputStream to) throws IOException {
        InputStream in = new FileInputStream(from);
        try {
            byte[] b = new byte[64 * 1024];
            int n;
            while ((n = in.read(b)) > 0) to.write(b, 0, n);
        } finally {
            in.close();
            to.close();
        }
    }

    private static String mime(String file) {
        String f = file.toLowerCase();
        if (f.endsWith(".mkv")) return "video/x-matroska";
        if (f.endsWith(".avi")) return "video/x-msvideo";
        if (f.endsWith(".ts")) return "video/mp2t";
        if (f.endsWith(".webm")) return "video/webm";
        return "video/mp4";
    }

    private void deleteSaved(Item it) {
        if (it.uri.isEmpty()) return;
        try {
            Uri u = Uri.parse(it.uri);
            if ("file".equals(u.getScheme())) new File(u.getPath()).delete();
            else ctx.getContentResolver().delete(u, null, null);
        } catch (RuntimeException ignored) {
            // already gone
        }
    }

    /** True while the saved file still exists (the user may have deleted it in a file manager). */
    private boolean exists(Item it) {
        try {
            Uri u = Uri.parse(it.uri);
            if ("file".equals(u.getScheme())) return new File(u.getPath()).exists();
            ctx.getContentResolver().openFileDescriptor(u, "r").close();
            return true;
        } catch (Exception gone) {
            return false;
        }
    }

    /** Drops finished entries whose file is gone. */
    synchronized void forgetMissing() {
        boolean any = false;
        for (Item it : new ArrayList<Item>(items)) {
            if (it.state.equals("done") && !exists(it)) { items.remove(it); any = true; }
        }
        if (any) save();
    }

    // ---- persistence ----

    private synchronized void save() {
        try {
            JSONArray a = new JSONArray();
            for (Item it : items) {
                JSONObject o = new JSONObject();
                o.put("id", it.id); o.put("origin", it.origin); o.put("p", it.p); o.put("sid", it.sid); o.put("ext", it.ext);
                o.put("name", it.name); o.put("state", it.state); o.put("reason", it.reason); o.put("uri", it.uri);
                o.put("total", it.total); o.put("done", it.done);
                a.put(o);
            }
            FileOutputStream f = new FileOutputStream(stateFile);
            f.write(a.toString().getBytes("UTF-8"));
            f.close();
        } catch (Exception ignored) {
            // best effort: a lost state file only forgets the list
        }
    }

    private void load() {
        try {
            if (!stateFile.exists()) return;
            InputStream in = new FileInputStream(stateFile);
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            in.close();
            JSONArray a = new JSONArray(bo.toString("UTF-8"));
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                Item it = new Item();
                it.id = o.getString("id"); it.origin = o.getString("origin"); it.p = o.getString("p"); it.sid = o.getString("sid");
                it.ext = o.optString("ext", "mp4"); it.name = o.optString("name", it.sid); it.uri = o.optString("uri", "");
                it.total = o.optLong("total", 0); it.done = o.optLong("done", 0);
                String st = o.optString("state", "queued");
                it.state = st.equals("done") || st.equals("paused") || st.equals("failed") ? st : "queued";   // what was running starts again
                it.reason = it.state.equals("failed") ? o.optString("reason", "") : "";
                items.add(it);
            }
        } catch (Exception ignored) {
            // an unreadable state file starts an empty list
        }
        if (activeCount() > 0) pump();
    }
}
