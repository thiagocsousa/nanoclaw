export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  // Override the JID injected as NANOCLAW_CHAT_JID into the container.
  // Use when the group's own JID is virtual (e.g. pipeline groups) and
  // approval/notification messages should go to a different chat.
  approvalJid?: string;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  approval_jid?: string | null;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed' | 'running';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

/**
 * O que aconteceu com uma tentativa de envio.
 *
 * ⛔ Existe porque `Promise<void>` não distinguia "saiu" de "não saiu", e quem
 * chamava concluía o otimista. Era o que armava a janela de supressão de
 * resposta a pipeline mesmo quando a mensagem foi RECUSADA pela política de
 * egresso (a trava da semana de observação) ou ficou na fila da reconexão — e
 * aí um "sim" legítimo do paciente, numa conversa com a secretária, era
 * descartado como eco de um lembrete que ele nunca recebeu.
 *
 * ⚠️ `enviado` quer dizer que o SOCKET aceitou, não que o paciente recebeu.
 * Não há confirmação de entrega aqui, e nada deve ser construído como se
 * houvesse.
 *
 * `recusado` e `enfileirado` são opostos operacionalmente — um é a política
 * trabalhando, o outro é a rede — e por isso são estados distintos, não um
 * `false` comum.
 */
export type ResultadoDoEnvio = 'enviado' | 'recusado' | 'enfileirado';

export interface Channel {
  name: string;
  connect(): Promise<void>;
  /**
   * ⚠️ `origem` existe por causa do incidente de 20/10/2026: a política de
   * observação precisa saber se isto veio do TURNO da Lara ou de um pipeline da
   * clínica. Bloquear por ALVO quebraria o lembrete de consulta, a
   * auto-resposta, a nota fiscal e a avaliação pós-consulta — um paciente que
   * escrevesse na semana deixaria de receber o lembrete da própria consulta.
   *
   * Opcional, e quem não declara é tratado como `turno`: falha FECHADO. Ver
   * `podeEntregar` em revisao-humana.ts.
   */
  sendMessage(
    jid: string,
    text: string,
    origem?: string,
  ): Promise<ResultadoDoEnvio>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: send image file. Path must be an absolute host path.
  sendImage?(
    jid: string,
    imagePath: string,
    caption?: string,
    origem?: string,
  ): Promise<void>;
  // Optional: send a document/file (e.g. PDF). Path must be an absolute host path.
  sendDocument?(
    jid: string,
    filePath: string,
    fileName?: string,
    caption?: string,
    origem?: string,
  ): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean, origem?: string): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: returns true when this channel is the designated sender for a group folder.
  ownsGroup?(folder: string): boolean;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
