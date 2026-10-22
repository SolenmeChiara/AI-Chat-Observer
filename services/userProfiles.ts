// 用户身份（UserProfile）的增删改切。电脑端侧栏、右栏身份下拉、手机远程动作三处共用。
//
// 全是纯函数：吃一份 GlobalSettings，吐一份新的（或失败短码），调用方用函数式
// setSettings(s => …) 套上去。这样手机动作和电脑端同时改设置时，谁也不会拿着
// 渲染期的旧快照把对方的改动整份盖掉。
//
// 唯一要守的不变量：提示词只读 legacy 三件套（userName / userAvatar / userPersona），
// 所以「当前身份」变了、或者当前身份本身被改了，三件套必须同一次写入跟着变
// （PROMPT_TIMESTAMP_PLAN.md:53 记过只写指针不写三件套的错位 bug）。
// 旁白模式下三件套保留上一个真实身份，不动。

import type { GlobalSettings, UserProfile } from '../types';
import { NARRATOR_PROFILE_ID } from '../server/actionContract';

export type ProfileOpError = 'profile-not-found' | 'last-profile';

export type ProfileOpResult =
  | { ok: true; settings: GlobalSettings }
  | { ok: false; error: ProfileOpError };

/** 把某个身份写进 legacy 三件套 */
function withLegacy(s: GlobalSettings, p: UserProfile): GlobalSettings {
  return { ...s, userName: p.name, userAvatar: p.avatar, userPersona: p.persona };
}

/** 切到某个身份，或旁白模式（NARRATOR_PROFILE_ID） */
export function switchProfile(s: GlobalSettings, profileId: string): ProfileOpResult {
  if (profileId === NARRATOR_PROFILE_ID) {
    return { ok: true, settings: { ...s, activeProfileId: NARRATOR_PROFILE_ID } };
  }
  const profile = (s.userProfiles || []).find(p => p.id === profileId);
  if (!profile) return { ok: false, error: 'profile-not-found' };
  return { ok: true, settings: withLegacy({ ...s, activeProfileId: profileId }, profile) };
}

/** 改某个身份的字段；改的是当前身份时三件套一起跟上 */
export function updateProfile(
  s: GlobalSettings,
  profileId: string,
  updates: Partial<Pick<UserProfile, 'name' | 'avatar' | 'persona'>>
): ProfileOpResult {
  const profiles = s.userProfiles || [];
  if (!profiles.some(p => p.id === profileId)) return { ok: false, error: 'profile-not-found' };
  const nextProfiles = profiles.map(p => (p.id === profileId ? { ...p, ...updates } : p));
  const next: GlobalSettings = { ...s, userProfiles: nextProfiles };
  if (s.activeProfileId === profileId) {
    const updated = nextProfiles.find(p => p.id === profileId);
    if (updated) return { ok: true, settings: withLegacy(next, updated) };
  }
  return { ok: true, settings: next };
}

/**
 * 新建一个身份（不切过去，和电脑端「添加新档案」一致）。
 * id 由调用方给：远程动作要在回执里带回去，得在写 state 之前就知道它。
 */
export function createProfile(s: GlobalSettings, profile: UserProfile): GlobalSettings {
  return { ...s, userProfiles: [...(s.userProfiles || []), profile] };
}

/**
 * 删一个身份。最后一个不让删；删的是当前身份就切到剩下的第一个。
 * 旁白模式下删任何一个都不改指针（三件套里那份上一个身份留着，切回来时会被重新覆盖）。
 */
export function deleteProfile(s: GlobalSettings, profileId: string): ProfileOpResult {
  const profiles = s.userProfiles || [];
  if (!profiles.some(p => p.id === profileId)) return { ok: false, error: 'profile-not-found' };
  if (profiles.length <= 1) return { ok: false, error: 'last-profile' };
  const rest = profiles.filter(p => p.id !== profileId);
  const next: GlobalSettings = { ...s, userProfiles: rest };
  if (s.activeProfileId === profileId) {
    return { ok: true, settings: withLegacy({ ...next, activeProfileId: rest[0].id }, rest[0]) };
  }
  return { ok: true, settings: next };
}

/** 新身份的 id。和电脑端侧栏的老格式一致（user-<时间戳>），再带一截随机数防同一毫秒撞车。 */
export function newProfileId(): string {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
