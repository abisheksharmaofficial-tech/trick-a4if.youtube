package tricka4if.youtube

import android.os.Bundle
import android.util.Log
import androidx.activity.OnBackPressedCallback
import com.getcapacitor.BridgeActivity

/** Native entry point for the Capacitor-hosted Trick A4IF YouTube app. */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        try {
            onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    try {
                        val webView = bridge?.webView
                        if (webView?.canGoBack() == true) {
                            webView.goBack()
                        } else {
                            isEnabled = false
                            onBackPressedDispatcher.onBackPressed()
                            isEnabled = true
                        }
                    } catch (error: Exception) {
                        Log.w(TAG, "Could not navigate the WebView back stack", error)
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            })
        } catch (error: Exception) {
            Log.e(TAG, "Could not install back navigation callback", error)
        }
    }

    override fun onResume() {
        super.onResume()
        try {
            bridge?.webView?.onResume()
        } catch (error: Exception) {
            Log.w(TAG, "Could not resume the Capacitor WebView", error)
        }
    }

    override fun onPause() {
        try {
            bridge?.webView?.onPause()
        } catch (error: Exception) {
            Log.w(TAG, "Could not pause the Capacitor WebView", error)
        } finally {
            super.onPause()
        }
    }

    override fun onDestroy() {
        try {
            bridge?.webView?.stopLoading()
        } catch (error: Exception) {
            Log.w(TAG, "Could not stop WebView loading during destruction", error)
        } finally {
            super.onDestroy()
        }
    }

    private companion object {
        const val TAG = "TrickA4IFMainActivity"
    }
}
