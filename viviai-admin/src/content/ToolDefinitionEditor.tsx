import type { AdminActor } from '../contracts';
import type { AdminClient } from '../http';
import { ContentEditor } from './ContentEditor';
import type { ToolRecord } from './contracts';

/** Keeps tool-specific routing explicit while sharing the audited content command flow. */
export function ToolDefinitionEditor(props: {
  record?: ToolRecord;
  actor: AdminActor;
  client: AdminClient;
  writeEnabled: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  return <ContentEditor kind="tools" {...props} />;
}
