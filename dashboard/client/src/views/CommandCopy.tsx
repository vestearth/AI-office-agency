import { ClipboardCopy } from 'lucide-react';
import { useToast } from '../components/Toast';

// A recommended action that is a command to run (the authorization grant) reads as
// one line with a copy button, in Attention and in Monitor; prose stays prose.

/** A recommended action that is a command to run, not prose. */
export function isShellCommand(text: string): boolean {
  return /^(ruby|bash|\.\/run-agent\.sh|scripts\/)\s?\S/.test(text.trim());
}

export function CommandCopy({ command, label }: { command: string; label?: string }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.show('Command copied; fill the <placeholders> before running it');
    } catch {
      toast.show('Clipboard not available', 'error');
    }
  };
  return (
    <span className="action-next-step action-command">
      <code title={command}>{command}</code>
      <button type="button" className="form-button action-copy-command" onClick={copy} aria-label={label ?? 'Copy the command'}>
        <ClipboardCopy size={12} /> Copy command
      </button>
    </span>
  );
}
