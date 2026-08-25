// timeline-core/test/helpers/eval-expr.mjs
/**
 * A real evaluator for the tiny expression dialect `src/expr.js` emits:
 * `if`, `between`, `+ - * /`, unary `-`, parentheses, `t`, numeric literals.
 *
 * Why this is honest rather than circular: the compiler no longer HAS easing
 * logic on the ffmpeg side — it emits straight lines between samples it took
 * through `sampleTrack`. So this evaluator is not a second copy of the easing
 * maths that could drift into agreement with a broken compiler; it is a
 * general interpreter for four operators and two functions. That is the whole
 * point of the piecewise-linear design.
 *
 * It is nonetheless cross-checked against the real ffmpeg binary in
 * `test/expr.ffmpeg.test.mjs`, because an evaluator that only agrees with
 * itself proves nothing about what ffmpeg will do.
 *
 * Semantics deliberately match ffmpeg's `av_expr`:
 *   - `between(x,min,max)` is INCLUSIVE at both ends, returning 1 or 0.
 *   - `if(cond,a,b)` treats any non-zero `cond` as true.
 */

/** @param {string} src @param {number} t */
export function evalExpr(src, t) {
  const p = new Parser(src, t)
  const v = p.parseExpr()
  p.skipWs()
  if (p.i < p.src.length) throw new Error(`trailing input at ${p.i} in ${src}`)
  return v
}

class Parser {
  constructor(src, t) {
    this.src = src
    this.i = 0
    this.t = t
  }

  skipWs() {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++
  }

  /** additive: term (('+'|'-') term)* */
  parseExpr() {
    let v = this.parseTerm()
    for (;;) {
      this.skipWs()
      const c = this.src[this.i]
      if (c === '+') { this.i++; v += this.parseTerm() }
      else if (c === '-') { this.i++; v -= this.parseTerm() }
      else return v
    }
  }

  /** multiplicative: unary (('*'|'/') unary)* */
  parseTerm() {
    let v = this.parseUnary()
    for (;;) {
      this.skipWs()
      const c = this.src[this.i]
      if (c === '*') { this.i++; v *= this.parseUnary() }
      else if (c === '/') { this.i++; v /= this.parseUnary() }
      else return v
    }
  }

  parseUnary() {
    this.skipWs()
    if (this.src[this.i] === '-') { this.i++; return -this.parseUnary() }
    if (this.src[this.i] === '+') { this.i++; return this.parseUnary() }
    return this.parseAtom()
  }

  parseAtom() {
    this.skipWs()
    const c = this.src[this.i]

    if (c === '(') {
      this.i++
      const v = this.parseExpr()
      this.expect(')')
      return v
    }

    if (/[A-Za-z_]/.test(c ?? '')) {
      const start = this.i
      while (this.i < this.src.length && /[A-Za-z_0-9]/.test(this.src[this.i])) this.i++
      const name = this.src.slice(start, this.i)
      this.skipWs()

      if (this.src[this.i] === '(') {
        const args = this.parseArgs()
        return this.callFn(name, args)
      }
      if (name === 't') return this.t
      throw new Error(`unknown identifier '${name}' in ${this.src}`)
    }

    return this.parseNumber()
  }

  parseArgs() {
    this.expect('(')
    const args = []
    for (;;) {
      args.push(this.parseExpr())
      this.skipWs()
      if (this.src[this.i] === ',') { this.i++; continue }
      this.expect(')')
      return args
    }
  }

  callFn(name, args) {
    switch (name) {
      case 'if':
        if (args.length !== 3) throw new Error(`if() takes 3 args, got ${args.length}`)
        // ffmpeg treats any non-zero as true. Both branches are already
        // evaluated here, which is fine for a pure dialect with no division
        // by a keyframe-derived zero (spans are guaranteed positive).
        return args[0] !== 0 ? args[1] : args[2]
      case 'between':
        if (args.length !== 3) throw new Error(`between() takes 3 args, got ${args.length}`)
        return args[0] >= args[1] && args[0] <= args[2] ? 1 : 0
      default:
        throw new Error(`unsupported function '${name}' — the compiler must not emit it`)
    }
  }

  parseNumber() {
    const m = /^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/.exec(this.src.slice(this.i))
    if (!m) throw new Error(`expected a number at ${this.i} in ${this.src}`)
    this.i += m[0].length
    return Number(m[0])
  }

  expect(ch) {
    this.skipWs()
    if (this.src[this.i] !== ch) {
      throw new Error(`expected '${ch}' at ${this.i} in ${this.src}`)
    }
    this.i++
  }
}
