/**
 * The two halves of profile-seeded caption defaults: ask the host what a
 * profile looks like, and fold the answer onto a freshly transcribed track.
 *
 * Both live here rather than inside the two components that use them because
 * they are used at two different moments of one flow — `CaptionRegenModal`
 * resolves the defaults *before* the stream starts (it needs the style to put
 * on the request), and `VideoEditor` merges them *after* it ends (at the one
 * seam that applies server-authored captions outside the undo stack). The
 * resolution happens once, in the modal, and rides along to the merge on the
 * `onDone` callback; neither side repeats the round trip, so they cannot
 * disagree about what the profile said.
 *
 * NOT to be confused with `captionStyleDefaults.ts` next door, which is a
 * hand-copied mirror of each render TEMPLATE's own parameter defaults. These
 * are the HOST's defaults for one named profile, and the editor knows nothing
 * about where they come from.
 */
import type { CaptionProfileDefaults, EditorAdapter, Project } from '../types'
import type { Captions } from '../schema'

/**
 * Ask the host for `profile`'s caption defaults, best-effort.
 *
 * Returns `null` — never throws, never rejects — when the project has no
 * profile, when the host implements no `getCaptionProfileDefaults`, or when
 * that call fails in any way. Seeding is a convenience laid over the user's
 * actual request (regenerate my captions); a profile lookup that 500s must not
 * be the reason that request cannot be made. The synchronous `try` matters as
 * much as the `.catch`: an adapter method that throws before returning its
 * promise would otherwise escape past the await.
 */
export async function resolveCaptionProfileDefaults<P extends Project = Project>(
  adapter: EditorAdapter<P>,
  profile: string | undefined | null,
): Promise<CaptionProfileDefaults | null> {
  if (!profile || !adapter.getCaptionProfileDefaults) return null
  try {
    return (await adapter.getCaptionProfileDefaults(profile)) ?? null
  } catch {
    return null
  }
}

/**
 * Fold `defaults` onto a freshly transcribed `captions` track, filling only
 * the fields the host's response left unset.
 *
 * Three rules, each load-bearing:
 *
 *  - **The server's value always wins.** The caption route returns a bare
 *    `{ style, segments }` today, so in practice every seedable field is
 *    absent — but a profile default is the weakest possible authority on a
 *    track's look, below anything the host chose to state, and the day the
 *    route starts carrying a color is not the day this should start
 *    clobbering it.
 *  - **`style` is never written onto the track.** It seeds the generation
 *    REQUEST (`GenerateCaptionsOptions.style`); what comes back reports the
 *    style actually transcribed with, and that report is the truth.
 *  - **`googleFonts` rides with `fontFamily` or not at all.** Seeding a
 *    family without its font spec renders the fallback face with nothing on
 *    screen to say so (see `Captions.fontFamily`), and seeding a spec for a
 *    family we did not apply just fetches bytes no glyph uses.
 *
 * Returns the ORIGINAL object by reference when there is nothing to seed. The
 * result goes straight to `applyExternal`, and a fresh object there is a state
 * change the editor reconciles — and, downstream, a project that differs from
 * one produced before this feature existed, for no reason a user could name.
 */
export function mergeCaptionProfileDefaults(
  captions: Captions,
  defaults: CaptionProfileDefaults | null | undefined,
): Captions {
  if (!defaults) return captions

  const patch: Partial<Captions> = {}
  if (captions.fontFamily == null && defaults.fontFamily) {
    patch.fontFamily = defaults.fontFamily
    if (captions.googleFonts == null && defaults.googleFonts?.length) {
      patch.googleFonts = defaults.googleFonts
    }
  }
  if (captions.color == null && defaults.color) patch.color = defaults.color

  return Object.keys(patch).length === 0 ? captions : { ...captions, ...patch }
}
