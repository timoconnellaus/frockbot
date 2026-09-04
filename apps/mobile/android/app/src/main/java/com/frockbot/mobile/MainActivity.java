package com.frockbot.mobile;

import android.os.Build;
import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FrockBotGoogleAuthPlugin.class);
        registerPlugin(FrockBotMobilePlugin.class);
        super.onCreate(savedInstanceState);

        // Android 15 enforces edge-to-edge for this target SDK; opting in
        // explicitly gives older supported Android releases the same layout.
        WindowCompat.enableEdgeToEdge(getWindow());
        WindowInsetsControllerCompat systemBars = WindowCompat.getInsetsController(
            getWindow(),
            getWindow().getDecorView()
        );
        // The hosted application is always dark, independently of the device
        // theme, so both sets of foreground icons must stay light.
        systemBars.setAppearanceLightStatusBars(false);
        systemBars.setAppearanceLightNavigationBars(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Do not let three-button navigation add a grey contrast scrim.
            getWindow().setNavigationBarContrastEnforced(false);
        }
    }
}
