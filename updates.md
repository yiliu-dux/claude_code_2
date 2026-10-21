# Updates

## Copy (Ctrl+C) lost after the message box was focused

- Symptom: after the message box had been focused, selecting text in the chat and pressing Ctrl+C moved focus to the message box and nothing was copied. Reloading the window or reopening the chat fixed it until the box was focused again.
- Cause (best explanation, not proven): clicking plain log text left no focusable element to take focus, so the message box stayed the remembered focus target and got focus back when VS Code returned focus to the webview.
- Fix: `#scroller` is focusable (`tabindex="-1"`, `outline: none`), so clicking in the log moves focus there.
