package com.blackofduty.game;

import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import androidx.activity.EdgeToEdge;

/**
 * The whole native surface of the game.
 *
 * That is a deliberate statement, not an oversight. Everything else — input,
 * quality tiers, the loading screen, the HUD — is the same code the browser runs,
 * and keeping it that way is what makes the two builds impossible to drift apart.
 *
 * Three things genuinely cannot be done from the page, and are done here:
 *
 *   1. LANDSCAPE LOCK. `screenOrientation="sensorLandscape"` in the manifest is
 *      enforced by the OS. The web build can only *ask*, via
 *      `screen.orientation.lock`, which needs a fullscreen context and is not
 *      available on iOS at all. Here it just works, always.
 *
 *   2. IMMERSIVE MODE. Hiding the status and navigation bars is what gives the
 *      game the full screen. The browser cannot do it without a fullscreen
 *      request, which needs a gesture and shows its own transient UI.
 *
 *   3. KEEP THE SCREEN ON. A player cannot pause to stop the display sleeping —
 *      there is no pause menu in the way, and a phone that sleeps mid-firefight
 *      loses the session. `FLAG_KEEP_SCREEN_ON` is the correct tool and only
 *      exists natively.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Immersive: no status bar, no navigation bar. Re-applied on every
        // window-focus change because the bars come back after a notification
        // shade pull or a screen rotation, and a game that suddenly grows two
        // bars is instantly rescaled and letterboxed.
        goImmersive();

        // The display must not sleep mid-fight.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();
    }

    /**
     * Hide the system bars, and make them stay hidden.
     *
     * `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` means a swipe from an edge brings
     * them back temporarily and they auto-hide again, rather than latching
     * open. Both flags matter: without BEHAVIOR the bars return on any
     * interaction and never leave.
     */
    private void goImmersive() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }
}
