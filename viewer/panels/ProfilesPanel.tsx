// 侧边栏 · 我的身份：切换 / 新建 / 编辑 / 删除用户身份（UserProfile），含旁白模式。
//
// 写法照抄 AgentEditPanel：表单是一份草稿 + 一份基线，保存只提交改过的键
// （profile.update 是覆盖写，把没动的字段一起发回去会吃掉电脑端同一时刻的改动）；
// catalog 刷新过投影时，本地没有未保存改动才跟着更新，免得冲掉正在打的字。
//
// 人设正文现在可以出电脑（PHONE_VIEWER_PLAN §0 的规则已放宽），API key 依旧不出。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ImagePlus, Megaphone, Plus, Save, Trash2 } from 'lucide-react';
import { ACTION_LIMITS, NARRATOR_PROFILE_ID } from '../../server/actionContract';
import type { ProfilePatch } from '../../server/actionContract';
import type { ViewUserProfile } from '../viewerClient';
import { ImagePrepError, compressAvatar } from '../imageUpload';
import { ActionButton, Field, PanelHint, SidebarRow, SidebarSection, inputClass, type PanelBaseProps } from './shared';

export interface ProfilesPanelProps extends PanelBaseProps {
  profiles: ViewUserProfile[];
  /** 电脑端当前身份；'narrator' = 旁白模式，空串 = 老服务端没给 */
  activeProfileId: string;
  /** 正在编辑的那个身份（新建成功后由 ViewerApp 按回执里的 profileId 设上） */
  selectedId: string | null;
  onSelect: (profileId: string | null) => void;
}

interface Draft {
  name: string;
  avatar: string;
  persona: string;
}

const toDraft = (p: ViewUserProfile): Draft => ({
  name: p.name || '',
  avatar: p.avatar || '',
  persona: p.persona || '',
});

const sameDraft = (a: Draft, b: Draft): boolean => a.name === b.name && a.avatar === b.avatar && a.persona === b.persona;

/** 头像小圆。头像可能是 URL / data URL，也可能是电脑端手填的 emoji 之类，img 显示不出来时退回首字 */
const Avatar: React.FC<{ src: string; name: string; size: number }> = ({ src, name, size }) => {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const style = { width: size, height: size };
  if (!src || broken) {
    return (
      <span
        style={style}
        className="shrink-0 rounded-full bg-gray-200 dark:bg-zinc-700 text-gray-500 dark:text-gray-300 flex items-center justify-center text-[12px] font-medium"
      >
        {(name || '?').slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      style={style}
      onError={() => setBroken(true)}
      className="shrink-0 rounded-full object-cover border border-gray-200 dark:border-zinc-700 bg-gray-100 dark:bg-zinc-800"
    />
  );
};

const ProfilesPanel: React.FC<ProfilesPanelProps> = ({
  t,
  lang,
  runAction,
  isPending,
  disabled,
  profiles,
  activeProfileId,
  selectedId,
  onSelect,
}) => {
  const selected = useMemo(() => profiles.find(p => p.id === selectedId) || null, [profiles, selectedId]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [preparingAvatar, setPreparingAvatar] = useState(false);
  const personaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastIdRef = useRef<string | null>(null);
  // 同 AgentEditPanel：effect 要读当前草稿与上一版基线，又不能把它们写进依赖
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  const baselineRef = useRef<Draft | null>(null);
  baselineRef.current = baseline;

  // 选中的 id 在列表里找不到时（刚新建、catalog 还没回来；或者被别处删了）只是不显示表单，
  // 不主动清掉：新建那一下回执比 catalog 先到，清掉的话新身份进列表时表单就不会自己展开了。

  useEffect(() => {
    if (!selected) {
      setDraft(null);
      setBaseline(null);
      lastIdRef.current = null;
      return;
    }
    const next = toDraft(selected);
    const switched = lastIdRef.current !== selected.id;
    const cur = draftRef.current;
    const base = baselineRef.current;
    const dirty = !switched && !!cur && !!base && !sameDraft(cur, base);
    lastIdRef.current = selected.id;
    setBaseline(next);
    if (!dirty) setDraft(next);
    if (switched) setError('');
  }, [selected]);

  const autoSize = useCallback(() => {
    const el = personaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, []);

  useEffect(() => {
    autoSize();
  }, [autoSize, draft?.persona, selectedId]);

  const patch = useMemo<ProfilePatch | null>(() => {
    if (!draft || !baseline) return null;
    const p: ProfilePatch = {};
    if (draft.name !== baseline.name) p.name = draft.name.trim();
    if (draft.avatar !== baseline.avatar) p.avatar = draft.avatar;
    if (draft.persona !== baseline.persona) p.persona = draft.persona;
    return Object.keys(p).length > 0 ? p : null;
  }, [draft, baseline]);

  const validate = (p: ProfilePatch): string => {
    if (p.name !== undefined) {
      if (!p.name) return t('名字不能为空');
      if (p.name.length > ACTION_LIMITS.name) return t('名字太长（上限 100 字）');
    }
    if (p.persona !== undefined && p.persona.length > ACTION_LIMITS.persona) return t('人设太长（上限 64000 字）');
    if (p.avatar !== undefined && p.avatar.length > ACTION_LIMITS.profileAvatar) return t('头像太大了');
    return '';
  };

  const pickAvatar = async (file: File | undefined) => {
    if (!file || !draft) return;
    setPreparingAvatar(true);
    setError('');
    try {
      const url = await compressAvatar(file);
      setDraft(d => (d ? { ...d, avatar: url } : d));
    } catch (err) {
      const code = err instanceof ImagePrepError ? err.code : 'decode-failed';
      setError(code === 'not-an-image' ? t('只能发图片') : code === 'too-large' ? t('头像太大了') : t('这张图读不出来'));
    } finally {
      setPreparingAvatar(false);
    }
  };

  const switchTo = (profileId: string) => {
    void runAction({
      type: 'profile.switch',
      payload: { profileId },
      key: `profile-switch:${profileId}`,
      label: t('切换身份'),
    });
  };

  const isNarrator = activeProfileId === NARRATOR_PROFILE_ID;
  const selectedIsActive = !!selected && selected.id === activeProfileId;

  return (
    <div className="pb-6">
      <SidebarSection>{t('发言身份')}</SidebarSection>
      {profiles.length === 0 && <PanelHint>{t('电脑端还没有任何身份')}</PanelHint>}
      {profiles.map(p => {
        const active = p.id === activeProfileId;
        return (
          <SidebarRow
            key={p.id}
            icon={<Avatar src={p.avatar} name={p.name} size={24} />}
            title={p.name || '—'}
            subtitle={(p.persona || '').trim().split('\n')[0].slice(0, 60) || t('无人设')}
            active={active}
            trailing={active ? <Check size={16} /> : undefined}
            onClick={() => onSelect(selectedId === p.id ? null : p.id)}
            action={
              active ? undefined : (
                <ActionButton
                  size="sm"
                  disabled={disabled}
                  pending={isPending(`profile-switch:${p.id}`)}
                  onClick={() => switchTo(p.id)}
                >
                  {t('设为当前')}
                </ActionButton>
              )
            }
          />
        );
      })}
      <SidebarRow
        icon={<Megaphone size={16} />}
        title={t('旁白')}
        subtitle={t('以系统消息样式发言，不带任何身份')}
        active={isNarrator}
        disabled={disabled}
        trailing={isNarrator ? <Check size={16} /> : undefined}
        onClick={() => {
          if (!isNarrator) switchTo(NARRATOR_PROFILE_ID);
        }}
      />
      <SidebarRow
        icon={<Plus size={16} />}
        title={t('新建身份')}
        disabled={disabled || isPending('profile-create')}
        onClick={() => {
          void runAction({
            type: 'profile.create',
            payload: {},
            key: 'profile-create',
            label: t('新建身份'),
          });
        }}
      />

      {selected && draft && (
        <div className="px-3 pt-3 mt-2 space-y-3 border-t border-gray-100 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <Avatar src={draft.avatar} name={draft.name} size={56} />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => {
                void pickAvatar(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <ActionButton
              size="sm"
              pending={preparingAvatar}
              disabled={disabled}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus size={14} /> {t('换头像')}
            </ActionButton>
            {!!baseline && draft.avatar !== baseline.avatar && (
              <ActionButton
                size="sm"
                onClick={() => setDraft({ ...draft, avatar: baseline.avatar })}
              >
                {t('还原')}
              </ActionButton>
            )}
          </div>

          <Field label={t('名字')}>
            <input
              type="text"
              value={draft.name}
              maxLength={ACTION_LIMITS.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              className={inputClass}
            />
          </Field>

          <Field label={t('人设 / 自我介绍（AI 可见）')}>
            <textarea
              ref={personaRef}
              value={draft.persona}
              onChange={e => {
                setDraft({ ...draft, persona: e.target.value });
                autoSize();
              }}
              rows={3}
              className={`${inputClass} resize-none overflow-y-auto`}
              style={{ minHeight: '96px' }}
            />
          </Field>

          {error && <div className="text-[11px] text-red-500">{error}</div>}

          <div className="flex items-center gap-2 pt-1">
            <ActionButton
              tone="primary"
              className="flex-1"
              pending={isPending(`profile-update:${selected.id}`)}
              disabled={disabled || !patch || preparingAvatar}
              onClick={() => {
                if (!patch) return;
                const msg = validate(patch);
                setError(msg);
                if (msg) return;
                void runAction({
                  type: 'profile.update',
                  payload: { profileId: selected.id, patch },
                  key: `profile-update:${selected.id}`,
                  label: t('保存身份'),
                });
              }}
            >
              <Save size={15} /> {t('保存')}
            </ActionButton>
            {!selectedIsActive && (
              <ActionButton
                disabled={disabled}
                pending={isPending(`profile-switch:${selected.id}`)}
                onClick={() => switchTo(selected.id)}
              >
                {t('设为当前')}
              </ActionButton>
            )}
            <ActionButton
              tone="danger"
              ariaLabel={t('删除身份')}
              disabled={disabled || profiles.length <= 1}
              pending={isPending(`profile-delete:${selected.id}`)}
              onClick={() => {
                const question =
                  lang === 'zh' ? `${t('删除身份')}「${selected.name}」？` : `${t('删除身份')} "${selected.name}"?`;
                if (!window.confirm(question)) return;
                void runAction({
                  type: 'profile.delete',
                  payload: { profileId: selected.id },
                  key: `profile-delete:${selected.id}`,
                  label: t('删除身份'),
                });
              }}
            >
              <Trash2 size={15} />
            </ActionButton>
          </div>
          {!patch && <div className="text-[11px] text-gray-400">{t('没有改动')}</div>}
          {profiles.length <= 1 && <div className="text-[11px] text-gray-400">{t('至少要留一个身份')}</div>}
        </div>
      )}
    </div>
  );
};

export default ProfilesPanel;
