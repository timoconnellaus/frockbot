package com.frockbot.mobile;

import android.content.MutableContextWrapper;
import android.os.CancellationSignal;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.security.SecureRandom;

@CapacitorPlugin(name = "FrockBotGoogleAuth")
public final class FrockBotGoogleAuthPlugin extends Plugin {
    private static final int NONCE_BYTES = 32;
    private final SecureRandom secureRandom = new SecureRandom();
    private CancellationSignal activeSignIn;

    @PluginMethod
    public void signIn(PluginCall call) {
        if (call.getData().length() != 0) {
            call.reject("Google sign-in received unexpected information.");
            return;
        }
        String serverClientId = getConfig().getString("serverClientId");
        if (serverClientId == null || serverClientId.isBlank()) {
            call.reject("Google sign-in is not configured for this app.");
            return;
        }

        CancellationSignal cancellationSignal;
        synchronized (this) {
            if (activeSignIn != null) {
                call.reject("Google sign-in is already in progress.");
                return;
            }
            cancellationSignal = new CancellationSignal();
            activeSignIn = cancellationSignal;
        }

        String nonce = createNonce();
        GetSignInWithGoogleOption googleOption = new GetSignInWithGoogleOption.Builder(serverClientId)
            .setNonce(nonce)
            .build();
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(googleOption)
            .build();
        CredentialManager credentialManager = CredentialManager.create(getContext());
        MutableContextWrapper activityContext = new MutableContextWrapper(getActivity());

        credentialManager.getCredentialAsync(
            activityContext,
            request,
            cancellationSignal,
            ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    finishSignIn(cancellationSignal);
                    resolveGoogleCredential(call, response, nonce);
                }

                @Override
                public void onError(@NonNull GetCredentialException error) {
                    finishSignIn(cancellationSignal);
                    if (error instanceof GetCredentialCancellationException) {
                        call.reject("Google sign-in was cancelled.");
                    } else if (error instanceof NoCredentialException) {
                        call.reject("No Google account is available on this device.");
                    } else {
                        call.reject("Google sign-in could not be completed.");
                    }
                }
            }
        );
    }

    private String createNonce() {
        byte[] bytes = new byte[NONCE_BYTES];
        secureRandom.nextBytes(bytes);
        return Base64.encodeToString(bytes, Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE);
    }

    private synchronized void finishSignIn(CancellationSignal cancellationSignal) {
        if (activeSignIn == cancellationSignal) {
            activeSignIn = null;
        }
    }

    private void resolveGoogleCredential(PluginCall call, GetCredentialResponse response, String nonce) {
        Credential credential = response.getCredential();
        if (!(credential instanceof CustomCredential customCredential) ||
            !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(customCredential.getType())) {
            call.reject("Google returned an unsupported sign-in response.");
            return;
        }
        try {
            GoogleIdTokenCredential googleCredential = GoogleIdTokenCredential.createFrom(customCredential.getData());
            String idToken = googleCredential.getIdToken();
            if (idToken.isBlank()) {
                call.reject("Google returned an empty sign-in token.");
                return;
            }
            JSObject result = new JSObject();
            result.put("idToken", idToken);
            result.put("nonce", nonce);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Google returned an invalid sign-in response.");
        }
    }

    @Override
    protected synchronized void handleOnDestroy() {
        if (activeSignIn != null) {
            activeSignIn.cancel();
            activeSignIn = null;
        }
        super.handleOnDestroy();
    }
}
