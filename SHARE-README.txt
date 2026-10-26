TWITCH CHANNEL CONTROL
======================

1. Extract the ZIP file.
2. Run "Twitch Channel Control 0.1.0.exe".
3. Use Authorize on each slot and enter the Client ID from your Twitch Developer App.
4. Register this redirect URL in that Twitch Developer App:

   http://localhost:47831/oauth/callback

The program stores account authorization securely on the local computer. The ZIP does
not include the original developer's accounts, tokens, Chrome profiles, or dependencies.

The Open button beside a saved channel opens that channel in the account's isolated
Chrome profile. BetterTTV must be installed separately for each profile.

Use the Profile Stats section to review each connected account and joined channel.
Twitch does not expose a viewer's current Channel Points balance through the official
API, so that field is shown as unavailable rather than guessed. Settings can enable
Windows tray mode so closing the window keeps the control app available in the tray.

To use the optional browser monitor, click Set up monitor for a joined account. If
Chrome does not load it automatically, open chrome://extensions in that account's
profile, enable Developer mode, choose Load unpacked, and select the browser-extension
folder shown by the app. Reload the Twitch tab afterward.
