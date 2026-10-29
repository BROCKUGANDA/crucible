/**
 * One page of the site, as two very different readers see it.
 *
 * Frenchy reads it to know where she may send a visitor and what she may
 * point at; the Tour page reads it to show a visitor the whole site at once.
 * Both read *this* file, so the map a person sees and the map the assistant
 * acts on cannot disagree - which is the entire reason this is a package
 * rather than a list inside one of them.
 *
 * The entries are generated from the descriptors each page declares
 * (`scripts/site-index.ts`), so the map cannot drift away from the routes.
 */

/** One page, with what it is for and what a visitor can do there. */
export interface SiteEntry {
  /**
   * The route, as the app router writes it: `/trials`, `/trials/[id]`.
   *
   * A dynamic route is written with its parameter in brackets, because that is
   * the shape the router uses and the shape a reader recognises.
   */
  path: string;
  /** What the navigation calls it. */
  label: string;
  /**
   * One sentence: what this page is for.
   *
   * This is the sentence Frenchy says when she sends someone here, and the
   * one a visitor reads in the Tour. It says what the page *is*, not what it
   * is called - a label repeats the navigation, a purpose earns the place.
   */
  purpose: string;
  /** What a visitor can do here, in plain words. */
  can: string[];
  /**
   * The element ids Frenchy may point at on this page.
   *
   * An id that is not on the page is a promise the page does not keep, so the
   * generator refuses to emit one: the id has to exist in the page's own
   * source. Pointing is the half of "computer use" that has to be checkable,
   * because a point that lands nowhere is a Frenchy who said "here" and
   * pointed at nothing.
   */
  points?: string[];
  /**
   * What the page needs before it can do anything useful - a connected
   * wallet, an id in the URL. Frenchy says this instead of sending someone to
   * a page that will only tell them to connect.
   */
  needs?: string;
}
