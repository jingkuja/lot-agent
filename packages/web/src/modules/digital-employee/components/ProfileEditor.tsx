import { useEffect, useState } from "react";
import type { CustomerProfile, Health, ProfileInput, RelationshipStage } from "../types.js";
import { HEALTH_LABELS, RELATIONSHIP_LABELS } from "../types.js";

interface ProfileEditorProps {
  profile?: CustomerProfile;
  saving?: boolean;
  onClose: () => void;
  onSave: (input: ProfileInput) => Promise<void> | void;
}

interface FormState {
  displayName: string;
  aliases: string;
  customerRegion: string;
  phone: string;
  email: string;
  wechat: string;
  source: string;
  tags: string;
  relationshipStage: RelationshipStage;
  overallHealth: Health;
  lockRelationship: boolean;
  lockOverallHealth: boolean;
}

function stateFor(profile?: CustomerProfile): FormState {
  const contact = profile?.contact ?? {};
  return {
    displayName: profile?.displayName ?? "",
    aliases: profile?.aliases.join("、") ?? "",
    customerRegion: profile?.customerRegion ?? "",
    phone: contact.phone ?? "",
    email: contact.email ?? "",
    wechat: contact.wechat ?? "",
    source: profile?.source ?? "",
    tags: profile?.tags.join("、") ?? "",
    relationshipStage: profile?.relationshipStage ?? "lead",
    overallHealth: profile?.overallHealth ?? "healthy",
    lockRelationship: profile?.manualLockFields.includes("relationshipStage") ?? false,
    lockOverallHealth: profile?.manualLockFields.includes("overallHealth") ?? false,
  };
}

function split(value: string): string[] {
  return value
    .split(/[、,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ProfileEditor({ profile, saving = false, onClose, onSave }: ProfileEditorProps) {
  const [form, setForm] = useState<FormState>(() => stateFor(profile));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm(stateFor(profile)), [profile]);

  const change = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.displayName.trim()) {
      setError("请填写客户名称");
      return;
    }
    setError(null);
    const contact = {
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
      ...(form.email.trim() ? { email: form.email.trim() } : {}),
      ...(form.wechat.trim() ? { wechat: form.wechat.trim() } : {}),
    };
    try {
      await onSave({
        displayName: form.displayName.trim(),
        aliases: split(form.aliases),
        customerRegion: form.customerRegion.trim() || null,
        contact: Object.keys(contact).length ? contact : null,
        source: form.source.trim() || null,
        tags: split(form.tags),
        relationshipStage: form.relationshipStage,
        overallHealth: form.overallHealth,
        manualLockFields: [
          ...(form.lockRelationship ? ["relationshipStage"] : []),
          ...(form.lockOverallHealth ? ["overallHealth"] : []),
        ],
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败，请重试");
    }
  };

  return (
    <div className="de-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="de-modal" role="dialog" aria-modal="true" aria-label={profile ? "编辑客户画像" : "新建客户画像"} onMouseDown={(event) => event.stopPropagation()}>
        <div className="de-modal-head">
          <div>
            <h2>{profile ? "编辑客户画像" : "新建客户画像"}</h2>
            <p>身份信息与当前关系分开维护；联系方式只在当前账号内加密保存。</p>
          </div>
          <button className="de-icon-button" type="button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <form className="de-form" onSubmit={submit}>
          <div className="de-form-grid">
            <label>
              <span>客户名称 *</span>
              <input value={form.displayName} onChange={(event) => change("displayName", event.target.value)} maxLength={200} autoFocus />
            </label>
            <label>
              <span>别名</span>
              <input value={form.aliases} onChange={(event) => change("aliases", event.target.value)} placeholder="如：李姐、李总（用顿号或逗号分隔）" maxLength={1_000} />
            </label>
            <label>
              <span>客户区域</span>
              <input value={form.customerRegion} onChange={(event) => change("customerRegion", event.target.value)} placeholder="如：华东、深圳南山区、北京及周边" maxLength={500} />
            </label>
            <label>
              <span>总体关系</span>
              <select value={form.relationshipStage} onChange={(event) => change("relationshipStage", event.target.value as RelationshipStage)}>
                {Object.entries(RELATIONSHIP_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>整体健康度</span>
              <select value={form.overallHealth} onChange={(event) => change("overallHealth", event.target.value as Health)}>
                {Object.entries(HEALTH_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>来源</span>
              <input value={form.source} onChange={(event) => change("source", event.target.value)} placeholder="如：展会、转介绍" maxLength={64} />
            </label>
            <label>
              <span>标签</span>
              <input value={form.tags} onChange={(event) => change("tags", event.target.value)} placeholder="如：重点客户、边缘算力" maxLength={1_500} />
            </label>
          </div>

          <fieldset className="de-form-section">
            <legend>联系方式（可选）</legend>
            <div className="de-form-grid">
              <label><span>手机号</span><input value={form.phone} onChange={(event) => change("phone", event.target.value)} maxLength={200} /></label>
              <label><span>邮箱</span><input value={form.email} onChange={(event) => change("email", event.target.value)} maxLength={200} /></label>
              <label><span>微信</span><input value={form.wechat} onChange={(event) => change("wechat", event.target.value)} maxLength={200} /></label>
            </div>
          </fieldset>

          <fieldset className="de-form-section">
            <legend>人工锁定</legend>
            <p className="de-field-hint">锁定后，通用助手只能记录新观察，不能自动覆盖该字段。</p>
            <div className="de-check-row">
              <label><input type="checkbox" checked={form.lockRelationship} onChange={(event) => change("lockRelationship", event.target.checked)} /> 锁定总体关系</label>
              <label><input type="checkbox" checked={form.lockOverallHealth} onChange={(event) => change("lockOverallHealth", event.target.checked)} /> 锁定整体健康度</label>
            </div>
          </fieldset>

          {error && <p className="de-form-error" role="alert">{error}</p>}
          <footer className="de-modal-actions">
            <button className="de-secondary-button" type="button" onClick={onClose} disabled={saving}>取消</button>
            <button className="de-primary-button" type="submit" disabled={saving}>{saving ? "保存中…" : "保存画像"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
