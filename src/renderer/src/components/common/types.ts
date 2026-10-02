// Shared prop types of the common components.

/** Select option: value plus display label. Plain values (strings / numbers) are accepted too and shown as-is. */
export interface SelectOption<T extends string | number = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** IconButton look. ghost (default) suits toolbars; default / primary / danger are filled buttons. */
export type ButtonVariant = 'ghost' | 'default' | 'primary' | 'danger';

/** Control sizes: sm 22 px, md 28 px (default), lg 32 px. */
export type ControlSize = 'sm' | 'md' | 'lg';
