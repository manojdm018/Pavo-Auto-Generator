# Pavo Auto Generator

Chrome Manifest V3 prototype for Pavo at https://app.pavo-ai.work/.

It clicks one enabled **Generate** button, waits for an explicit generation indicator to disappear for several consecutive checks, then looks for the next enabled Generate button. It does not create or edit scripts or prompts.

## Install

1. Use **Code → Download ZIP** and extract the folder.
2. Open Chrome and visit `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extracted `Pavo-Auto-Generator` folder.
5. Open or reload your Pavo episode review page.
6. Click the extension icon and press **Start queue**.

## Controls

- **Start queue:** begin with the first enabled Generate button in DOM order.
- **Pause:** stop advancing; this does not cancel a generation already submitted.
- **Resume:** continue only when no generation is detected.
- **Stop:** stop the automation; it does not cancel an active Pavo job.

## Safety

- Checks visible labels such as Generating, Processing, Creating video, Rendering, and Stop.
- Uses a single-flight lock while a generation is active.
- Requires positive evidence that a click started generation.
- Requires six consecutive non-generating checks before advancing.
- Pauses after a 12-minute timeout or ambiguous UI state.
- Does not automatically resume after a page refresh.
- Never clicks Stop or Cancel.

## Prototype limitation

The screenshot confirms the visual layout but does not reveal Pavo's actual DOM. This version therefore uses conservative text-based detection, not verified Pavo-specific selectors. Before relying on it for a long batch, inspect the Generate button and the active generating state in Chrome DevTools and tune `content.js` to the exact DOM. If Pavo changes its labels or status display, it may pause rather than proceed.

## Privacy

Runs only on `https://app.pavo-ai.work/*`. Status is stored in `chrome.storage.local`. No prompts, videos, or account data are sent to an external service.

No build step or dependencies are required.