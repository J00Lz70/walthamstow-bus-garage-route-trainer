package uk.w19.routetrainer;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Walthamstow Bus Garage Route Trainer for Android.
 * Opens the hosted web app, so new versions and TfL updates arrive without reinstalling.
 * The web app's own offline cache keeps it working without signal; on a first launch with
 * no connection it opens the copy bundled inside the APK.
 */
public class MainActivity extends Activity {
    private static final String OFFLINE_URL = "file:///android_asset/www/index.html";
    private WebView web;
    private String startUrl;
    private boolean fellBack = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#101214"));
        startUrl = getString(R.string.start_url);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#EEF1F3"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith(startUrl) || url.startsWith("file:///android_asset/")) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && !fellBack) {
                    fellBack = true;
                    view.loadUrl(OFFLINE_URL);
                }
            }
        });

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else if (startUrl.startsWith("https://")) {
            web.loadUrl(startUrl);
        } else {
            web.loadUrl(OFFLINE_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
