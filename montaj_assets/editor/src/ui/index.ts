// Vendored UI primitives — self-contained copies of Montaj's shadcn-style
// components so the package has no `@/` host dependency. Tailwind classes are
// preserved verbatim; the host supplies the matching Tailwind theme.
export { cn } from './utils'
export { Button } from './button'
export type { ButtonProps } from './button'
export { Input, inspectorInputClass } from './input'
export type { InputProps } from './input'
export { Label } from './label'
export { Select } from './select'
export type { SelectProps } from './select'
export { SwatchInput } from './SwatchInput'
export type { SwatchInputProps } from './SwatchInput'
export { Switch } from './switch'
export { Textarea } from './textarea'
export type { TextareaProps } from './textarea'
export { Badge, StatusBadge } from './badge'
export type { BadgeProps } from './badge'
