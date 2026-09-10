import { cloneElement, createContext, useContext, useId, type ReactElement } from 'react';
export type FieldErrors = Record<string, string>;
const Errors = createContext<FieldErrors>({});
export const FieldErrorsProvider = Errors.Provider;
export function useFieldFeedback(name: string) {
  const errors = useContext(Errors);
  const id = useId();
  return { error: errors[name], errorId: `${id}-error`, inputId: id };
}
export function FormField({
  name,
  label,
  children,
}: {
  name: string;
  label: string;
  children: ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>;
}) {
  const { error, errorId, inputId } = useFieldFeedback(name);
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      {cloneElement(children, {
        id: inputId,
        'aria-invalid': Boolean(error),
        'aria-describedby': error ? errorId : undefined,
      })}
      {error && (
        <p className="team-field-error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
