package com.frockbot.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FrockBotGoogleAuthPlugin.class);
        registerPlugin(FrockBotMobilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
