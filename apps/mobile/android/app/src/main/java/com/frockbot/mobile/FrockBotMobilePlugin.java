package com.frockbot.mobile;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.Set;

@CapacitorPlugin(
    name = "FrockBotMobile",
    permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
)
public final class FrockBotMobilePlugin extends Plugin {
    private static final String READ_CLIPBOARD = "mobile.clipboard.readText";
    private static final String WRITE_CLIPBOARD = "mobile.clipboard.writeText";
    private static final String SHOW_NOTIFICATION = "mobile.notifications.show";
    private static final String CHANNEL_ID = "frockbot";

    @PluginMethod
    public void invoke(PluginCall call) {
        if (!exact(call.getData().keySet(), Set.of("schemaVersion", "commandId", "input")) || call.getInt("schemaVersion", 0) != 1) {
            call.reject("mobile broker request is invalid");
            return;
        }
        String commandId = call.getString("commandId");
        JSObject input = call.getObject("input");
        if (commandId == null || input == null) {
            call.reject("mobile broker request is invalid");
            return;
        }
        switch (commandId) {
            case READ_CLIPBOARD -> readClipboard(call, input);
            case WRITE_CLIPBOARD -> writeClipboard(call, input);
            case SHOW_NOTIFICATION -> showNotification(call, input);
            default -> call.reject("mobile command is unavailable");
        }
    }

    private static boolean exact(Set<String> actual, Set<String> expected) {
        return actual.equals(expected);
    }

    private ClipboardManager clipboard() {
        return (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
    }

    private void readClipboard(PluginCall call, JSObject input) {
        if (!input.isEmpty()) {
            call.reject("clipboard input has unknown fields");
            return;
        }
        ClipData clip = clipboard().getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) {
            call.reject("the clipboard does not hold text");
            return;
        }
        CharSequence text = clip.getItemAt(0).coerceToText(getContext());
        if (text == null || text.length() > 1_000_000) {
            call.reject("the clipboard does not hold bounded text");
            return;
        }
        JSObject result = new JSObject();
        result.put("text", text.toString());
        call.resolve(result);
    }

    private void writeClipboard(PluginCall call, JSObject input) {
        if (!exact(input.keySet(), Set.of("text"))) {
            call.reject("clipboard input has unknown fields");
            return;
        }
        String text = input.getString("text");
        if (text == null || text.length() > 1_000_000) {
            call.reject("clipboard text is invalid");
            return;
        }
        clipboard().setPrimaryClip(ClipData.newPlainText("FrockBot", text));
        JSObject result = new JSObject();
        result.put("written", true);
        call.resolve(result);
    }

    private void showNotification(PluginCall call, JSObject input) {
        if (!exact(input.keySet(), Set.of("title", "body", "urgency")) && !exact(input.keySet(), Set.of("title", "urgency"))) {
            call.reject("notification input has unknown fields");
            return;
        }
        String title = input.getString("title");
        String body = input.getString("body", "");
        String urgency = input.getString("urgency", "normal");
        if (title == null || title.isBlank() || title.length() > 200 || body.length() > 4096 || (!urgency.equals("normal") && !urgency.equals("critical"))) {
            call.reject("notification input is invalid");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermission");
            return;
        }
        deliverNotification(call, title, body, urgency);
    }

    @PermissionCallback
    private void notificationPermission(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("notification permission was denied");
            return;
        }
        showNotification(call, call.getObject("input", new JSObject()));
    }

    private void deliverNotification(PluginCall call, String title, String body, String urgency) {
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "FrockBot", NotificationManager.IMPORTANCE_DEFAULT));
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(getContext(), CHANNEL_ID)
            : new Notification.Builder(getContext());
        builder
            .setSmallIcon(getContext().getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(urgency.equals("critical") ? Notification.PRIORITY_HIGH : Notification.PRIORITY_DEFAULT);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            manager.notify((int) (System.currentTimeMillis() & 0x7fffffff), builder.build());
        }
        JSObject result = new JSObject();
        result.put("shown", true);
        call.resolve(result);
    }
}
