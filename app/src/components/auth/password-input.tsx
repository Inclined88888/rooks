'use client';

/**
 * A password field with its eye (the account step, the new password of a
 * reset). The eye has no text but an `aria-label`, stays out of the Tab
 * order — Tab goes from one field to the next — and never takes the focus:
 * the reader keeps typing where they were after a click on it.
 *
 * `shown` is held by the form: one eye shows both fields of a pair.
 */
import { forwardRef, type ComponentProps } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

export type PasswordInputProps = Omit<ComponentProps<'input'>, 'type'> & {
  shown: boolean;
  onToggleShown: () => void;
};

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { shown, onToggleShown, className, ...props },
  ref,
) {
  return (
    <div className="relative">
      <Input ref={ref} type={shown ? 'text' : 'password'} className={cn('pr-11', className)} {...props} />
      <button
        type="button"
        tabIndex={-1}
        aria-label={shown ? t('authForm.hidePassword') : t('authForm.showPassword')}
        aria-pressed={shown}
        data-password-eye=""
        // The field keeps the focus: a mousedown on a button would move it here.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleShown}
        className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {shown ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  );
});
