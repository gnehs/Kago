/**
 * How windows come and go, held to what an operating system does: the window has already opened, closed or been
 * put away by the time anything moves. What is seen leaving is a copy that takes no input and removes itself,
 * so no action ever waits for an animation, and a second action can always follow straight after the first.
 */

const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";

/** Off when the system asks for less motion, or when animations are turned off in the settings. */
export const motionAllowed = () => document.documentElement.dataset.motion !== "off" && !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Where a window goes when it is put away, and comes back from: its own button in the top bar. */
function dockOffset(element: HTMLElement, id: string) {
  const dock = document.querySelector<HTMLElement>(`[data-dock="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  const frame = element.getBoundingClientRect();
  if (!dock || frame.width === 0) return null;
  return { x: dock.left + dock.width / 2 - (frame.left + frame.width / 2), y: dock.top + dock.height / 2 - (frame.top + frame.height / 2) };
}

const docked = (offset: { x: number; y: number }): Keyframe => ({ opacity: 0, transform: `translate(${offset.x}px, ${offset.y}px) scale(0.1)` });

/** A window arriving: where it stands when it is new, out of the top bar when it had been put away. It can be used at once. */
export function animateWindowIn(element: HTMLElement, id: string, restored: boolean) {
  if (!motionAllowed()) return;
  const offset = restored ? dockOffset(element, id) : null;
  if (offset) element.animate([docked(offset), { opacity: 1, transform: "none" }], { duration: 150, easing: EASE_OUT });
  else element.animate([{ opacity: 0, transform: "scale(0.975)" }, { opacity: 1, transform: "none" }], { duration: 130, easing: EASE_OUT });
}

/**
 * A window leaving. Called just before the store closes or minimizes it: a copy is left where it stood,
 * which fades out, or shrinks into the top bar, on its own.
 */
export function ghostWindowOut(id: string, how: "close" | "minimize") {
  const element = document.querySelector<HTMLElement>(`[data-window="${CSS.escape(id)}"]`);
  if (!element || element.hidden || !element.parentElement || !motionAllowed()) return;
  const offset = how === "minimize" ? dockOffset(element, id) : null;
  const ghost = element.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("data-window");
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.style.pointerEvents = "none";
  // A copy of a picture that is still decoding, or of a player, would only flash; the frame is enough.
  for (const media of ghost.querySelectorAll("video, audio, iframe")) media.remove();
  element.parentElement.append(ghost);
  const animation = offset
    ? // It sets off at once rather than gathering speed, and is gone before it gets there.
      ghost.animate([{ opacity: 1, transform: "none" }, { ...docked(offset), offset: 0.85 }, docked(offset)], { duration: 120, easing: "cubic-bezier(0.3, 0, 0.7, 1)" })
    : ghost.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.975)" }], { duration: 110, easing: EASE_IN });
  const remove = () => ghost.remove();
  animation.finished.then(remove, remove);
  // Animations stand still in a tab that is not being drawn; the copy must not outlive its moment there.
  setTimeout(remove, 600);
}

type Box = { left: number; top: number; width: number; height: number };

/** A window growing to fill the desktop, or going back to the size it had. */
export function animateWindowBox(element: HTMLElement, from: Box, to: Box, toMaximized: boolean) {
  if (!motionAllowed()) return;
  const frame = (box: Box, radius: string): Keyframe => ({ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, right: "auto", bottom: "auto", borderRadius: radius });
  const round = "var(--kago-radius-lg)";
  element.animate([frame(from, toMaximized ? round : "0px"), frame(to, toMaximized ? "0px" : round)], { duration: 200, easing: EASE_OUT });
}
