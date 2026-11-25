package app.shellbeam

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
    companion object {
        private const val TAG = "ShellBeam"
    }

    private var multicastLock: WifiManager.MulticastLock? = null
    private var nsdHelper: NsdHelper? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val nsdBridge = NsdBridge()
    private var webViewRef: WebView? = null
    private var pendingCameraPermissionRequest: PermissionRequest? = null

    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val pending = pendingCameraPermissionRequest
            pendingCameraPermissionRequest = null
            if (pending != null) {
                if (granted) {
                    val videoRes = pending.resources.filter {
                        it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
                    }.toTypedArray()
                    if (videoRes.isNotEmpty()) {
                        pending.grant(videoRes)
                    } else {
                        pending.deny()
                    }
                } else {
                    pending.deny()
                }
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        acquireMulticastLock()
        setupNsd()
        setupBackNavigation()
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val webView = webViewRef
                if (webView == null) {
                    moveTaskToBack(true)
                    return
                }
                webView.evaluateJavascript(
                    "(function(){try{return typeof window.__shellbeamHandleAndroidBack==='function'?Boolean(window.__shellbeamHandleAndroidBack()):false;}catch(e){return false;}})()"
                ) { result ->
                    if (result != "true") {
                        // Keep SSH sessions alive in the background when at the root screen.
                        moveTaskToBack(true)
                    }
                }
            }
        })
    }

    /**
     * Called by WryActivity.setWebView() after Tauri creates the RustWebView.
     * This is the correct moment to install the JS bridge — the WebView is
     * fully initialized and will not be recreated.
     */
    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        Log.i(TAG, "onWebViewCreate: installing NSD bridge on ${webView.javaClass.name}")
        webViewRef = webView
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.addJavascriptInterface(nsdBridge, "ShellBeamNSD")
        installCameraPermissionWebChromeClient(webView)
        // Android 15+ enforces edge-to-edge. Chromium WebView ignores View.setPadding() on
        // itself, so apply systemBars + displayCutout + IME insets to its parent container
        // so status bar, punch-hole camera, gesture bar, and soft keyboard never overlap UI.
        val insetContainer: View = (webView.parent as? View) ?: findViewById(android.R.id.content)
        insetContainer.setBackgroundColor(Color.parseColor("#0b1020"))
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        ViewCompat.setOnApplyWindowInsetsListener(insetContainer) { view, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars()
                    or WindowInsetsCompat.Type.displayCutout()
                    or WindowInsetsCompat.Type.ime()
            )
            view.setPadding(insets.left, insets.top, insets.right, insets.bottom)
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(insetContainer)

        // Notify the frontend once the page is ready.
        // The bridge is available immediately after addJavascriptInterface,
        // but the frontend JS may not have loaded yet. Fire a custom event
        // after a short delay so the frontend can re-check.
        mainHandler.postDelayed({
            dispatchBridgeReady(webView)
        }, 1500)
        // Fire again a bit later in case the first one was too early
        mainHandler.postDelayed({
            dispatchBridgeReady(webView)
        }, 4000)
    }

    private fun installCameraPermissionWebChromeClient(webView: WebView) {
        val delegate = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.webChromeClient
        } else {
            null
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val wantsCamera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                if (!wantsCamera) {
                    delegate?.onPermissionRequest(request) ?: request.deny()
                    return
                }
                val granted = ContextCompat.checkSelfPermission(
                    this@MainActivity,
                    Manifest.permission.CAMERA,
                ) == PackageManager.PERMISSION_GRANTED
                if (granted) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                } else {
                    pendingCameraPermissionRequest?.deny()
                    pendingCameraPermissionRequest = request
                    runOnUiThread {
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                    }
                }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingCameraPermissionRequest == request) {
                    pendingCameraPermissionRequest = null
                }
                delegate?.onPermissionRequestCanceled(request)
            }

            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                return delegate?.onShowFileChooser(view, filePathCallback, fileChooserParams)
                    ?: super.onShowFileChooser(view, filePathCallback, fileChooserParams)
            }

            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                if (consoleMessage != null && (
                        consoleMessage.messageLevel() == ConsoleMessage.MessageLevel.ERROR ||
                        consoleMessage.messageLevel() == ConsoleMessage.MessageLevel.WARNING
                    )
                ) {
                    Log.w(TAG, "JS[${consoleMessage.messageLevel()}]: ${consoleMessage.message()}")
                }
                return delegate?.onConsoleMessage(consoleMessage)
                    ?: super.onConsoleMessage(consoleMessage)
            }

            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                return delegate?.onJsAlert(view, url, message, result)
                    ?: super.onJsAlert(view, url, message, result)
            }

            override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                return delegate?.onJsConfirm(view, url, message, result)
                    ?: super.onJsConfirm(view, url, message, result)
            }

            override fun onJsPrompt(
                view: WebView?,
                url: String?,
                message: String?,
                defaultValue: String?,
                result: JsPromptResult?,
            ): Boolean {
                return delegate?.onJsPrompt(view, url, message, defaultValue, result)
                    ?: super.onJsPrompt(view, url, message, defaultValue, result)
            }

            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message?,
            ): Boolean {
                return delegate?.onCreateWindow(view, isDialog, isUserGesture, resultMsg)
                    ?: super.onCreateWindow(view, isDialog, isUserGesture, resultMsg)
            }

            override fun onCloseWindow(window: WebView?) {
                delegate?.onCloseWindow(window) ?: super.onCloseWindow(window)
            }

            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                delegate?.onShowCustomView(view, callback) ?: super.onShowCustomView(view, callback)
            }

            override fun onHideCustomView() {
                delegate?.onHideCustomView() ?: super.onHideCustomView()
            }

            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                delegate?.onProgressChanged(view, newProgress) ?: super.onProgressChanged(view, newProgress)
            }

            override fun onReceivedTitle(view: WebView?, title: String?) {
                delegate?.onReceivedTitle(view, title) ?: super.onReceivedTitle(view, title)
            }
        }
    }

    private fun dispatchBridgeReady(webView: WebView) {
        webView.post {
            webView.evaluateJavascript(
                "(function(){" +
                    "if(typeof window.ShellBeamNSD!=='undefined'){" +
                    "  window.dispatchEvent(new CustomEvent('shellbeam-nsd-ready'));" +
                    "}" +
                    "})()", null
            )
        }
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        nsdHelper?.destroy()
        nsdHelper = null
        releaseMulticastLock()
        super.onDestroy()
    }

    private fun acquireMulticastLock() {
        try {
            val wifiManager = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
            multicastLock = wifiManager.createMulticastLock("shellbeam-mdns").apply {
                setReferenceCounted(true)
                acquire()
            }
            Log.i(TAG, "MulticastLock acquired")
        } catch (e: Exception) {
            Log.e(TAG, "MulticastLock failed: ${e.message}")
        }
    }

    private fun releaseMulticastLock() {
        try {
            multicastLock?.let { if (it.isHeld) it.release() }
            multicastLock = null
        } catch (_: Exception) {}
    }

    private fun setupNsd() {
        nsdHelper = NsdHelper(this).apply {
            onDeviceFound = { name, host, port, deviceType ->
                emitDeviceFound(name, host, port, deviceType)
            }
        }
    }

    inner class NsdBridge {
        @JavascriptInterface
        fun registerService(port: Int, instanceName: String) {
            Log.i(TAG, "JS -> registerService: port=$port name=$instanceName")
            nsdHelper?.registerService(port, instanceName)
        }

        @JavascriptInterface
        fun unregisterService() {
            Log.i(TAG, "JS -> unregisterService")
            nsdHelper?.unregisterService()
        }

        @JavascriptInterface
        fun startDiscovery() {
            Log.i(TAG, "JS -> startDiscovery")
            nsdHelper?.startDiscovery()
        }

        @JavascriptInterface
        fun stopDiscovery() {
            Log.i(TAG, "JS -> stopDiscovery")
            nsdHelper?.stopDiscovery()
        }

        @JavascriptInterface
        fun getDeviceName(): String {
            return android.os.Build.MODEL ?: "Android"
        }

        @JavascriptInterface
        fun logToNative(message: String) {
            Log.i(TAG, "JS-LOG: $message")
        }
    }

    private fun emitDeviceFound(name: String, host: String, port: Int, deviceType: String) {
        val json = """{"name":"${esc(name)}","host":"${esc(host)}","port":$port,"deviceType":"${esc(deviceType)}"}"""
        val js = """
            (function() {
                try {
                    window.dispatchEvent(new CustomEvent('shellbeam-nsd-device', {
                        detail: $json
                    }));
                } catch(e) { console.warn('NSD emit error:', e); }
            })();
        """.trimIndent()
        runOnUiThread { webViewRef?.evaluateJavascript(js, null) }
    }

    private fun esc(s: String): String {
        return s.replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
    }
}
