/** Persistence contracts for the Feishu integration. Secrets are encrypted by the server. */
export interface FeishuConnection {
  user_id: string;
  app_id: string;
  /** Required encrypted secret for this user's QR-created application. */
  app_secret: string;
  open_id: string;
  tenant_key: string;
  name: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scopes: string[];
  revision: string;
}

export interface FeishuSendRecord {
  request_id: string;
  fingerprint: string;
  status: "sending" | "sent" | "failed" | "unknown";
  message_id: string | null;
}

export interface FeishuUserStore {
  connection(): Promise<FeishuConnection | null>;
  saveConnection(connection: FeishuConnection): Promise<void>;
  disconnect(preserveContacts?: boolean): Promise<void>;
  contact(alias: string): Promise<string | null>;
  saveContact(alias: string, openId: string): Promise<void>;
  deleteContact(alias: string): Promise<void>;
  sendRecord(requestId: string): Promise<FeishuSendRecord | null>;
  saveSend(record: FeishuSendRecord): Promise<void>;
  setup(): Promise<FeishuSetup | null>;
  saveSetup(setup: FeishuSetup): Promise<void>;
  conversation(): Promise<string>;
}

export interface FeishuSetup {
  id: string;
  user_id: string;
  phase: "registration" | "authorization" | "verification" | "complete" | "failed";
  /** Entire pending credentials/device codes payload is encrypted. */
  data: string;
  expires_at: number;
  poll_after: number;
  interval: number;
  attempts: number;
}

export interface FeishuInboxJob {
  message_id: string;
  user_id: string;
  revision: string;
  text: string;
  chat_id: string;
  conversation_id?: string;
  user_message_id?: string;
  result_message_id?: string;
  run_id?: string;
}

export interface FeishuRepository {
  withUser<T>(userId: string, work: (store: FeishuUserStore) => Promise<T>): Promise<T>;
  findSender(appId: string, tenantKey: string, openId: string): Promise<FeishuConnection | null>;
  contacts(userId: string): Promise<Array<{ alias: string; open_id: string }>>;
  saveContact(userId: string, alias: string, openId: string): Promise<void>;
  deleteContact(userId: string, alias: string): Promise<void>;
  enqueue(job: FeishuInboxJob): Promise<boolean>;
  claim(): Promise<FeishuInboxJob | null>;
  finish(messageId: string, status: string): Promise<void>;
  active(job: FeishuInboxJob): Promise<boolean>;
  recent(userId: string): Promise<Array<{ message_id: string; status: string; created_at: string }>>;
  connections(): Promise<FeishuConnection[]>;
  recordResult(job: FeishuInboxJob, text: string, status: string): Promise<void>;
}
