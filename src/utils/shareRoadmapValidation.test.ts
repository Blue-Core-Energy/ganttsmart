import { describe, expect, it } from 'vitest';
import {
  canClaimRefresh,
  computeClientIpHash,
  extractClientIp,
  hashPasswordPBKDF2,
  isRateLimited,
  MAX_EXPIRY_DAYS,
  MAX_PASSWORD_ATTEMPTS,
  parseStartDate,
  RATE_LIMIT_WINDOW_MS,
  sanitizeCachedRoadmapData,
  sanitizeMilestone,
  sanitizeTask,
  STALE_TTL_MS,
  validateExpiresInDays,
  validatePassword,
  verifyPassword,
} from '../../supabase/functions/_shared/share-utils.ts';

describe('share-utils', () => {
  describe('validatePassword', () => {
    it('accepts valid string passwords up to 128 characters', () => {
      expect(validatePassword('secret123')).toEqual({ valid: true });
      expect(validatePassword('a'.repeat(128))).toEqual({ valid: true });
      expect(validatePassword('')).toEqual({ valid: true });
    });

    it('rejects passwords exceeding 128 characters', () => {
      const res = validatePassword('a'.repeat(129));
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/at most 128 characters/i);
    });

    it('rejects non-string values', () => {
      expect(validatePassword(12345).valid).toBe(false);
      expect(validatePassword(null).valid).toBe(false);
      expect(validatePassword(undefined).valid).toBe(false);
      expect(validatePassword({ password: 'foo' }).valid).toBe(false);
      expect(validatePassword(['pass']).valid).toBe(false);
      expect(validatePassword(true).valid).toBe(false);
    });
  });

  describe('validateExpiresInDays', () => {
    it('defaults to 3 days when omitted (undefined)', () => {
      expect(validateExpiresInDays(undefined)).toEqual({ valid: true, value: 3 });
    });

    it('rejects null explicitly', () => {
      const res = validateExpiresInDays(null);
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/expiresInDays must be an integer/i);
    });

    it('accepts valid integers between 1 and MAX_EXPIRY_DAYS (90)', () => {
      expect(validateExpiresInDays(1)).toEqual({ valid: true, value: 1 });
      expect(validateExpiresInDays(3)).toEqual({ valid: true, value: 3 });
      expect(validateExpiresInDays(MAX_EXPIRY_DAYS)).toEqual({ valid: true, value: MAX_EXPIRY_DAYS });
    });

    it('rejects values out of range', () => {
      expect(validateExpiresInDays(0).valid).toBe(false);
      expect(validateExpiresInDays(-5).valid).toBe(false);
      expect(validateExpiresInDays(MAX_EXPIRY_DAYS + 1).valid).toBe(false);
    });

    it('rejects non-integers and non-finite numbers', () => {
      expect(validateExpiresInDays(1.5).valid).toBe(false);
      expect(validateExpiresInDays(NaN).valid).toBe(false);
      expect(validateExpiresInDays(Infinity).valid).toBe(false);
    });

    it('rejects non-number types', () => {
      expect(validateExpiresInDays('3').valid).toBe(false);
      expect(validateExpiresInDays({ days: 3 }).valid).toBe(false);
      expect(validateExpiresInDays(true).valid).toBe(false);
    });
  });

  describe('extractClientIp', () => {
    it('prefers cf-connecting-ip', () => {
      const headers = new Headers({
        'cf-connecting-ip': '1.1.1.1',
        'x-real-ip': '2.2.2.2',
        'x-forwarded-for': '3.3.3.3, 4.4.4.4',
      });
      expect(extractClientIp(headers)).toBe('1.1.1.1');
    });

    it('prefers x-real-ip over x-forwarded-for when cf-connecting-ip is absent', () => {
      const headers = new Headers({
        'x-real-ip': '2.2.2.2',
        'x-forwarded-for': '3.3.3.3, 4.4.4.4',
      });
      expect(extractClientIp(headers)).toBe('2.2.2.2');
    });

    it('extracts rightmost IP from x-forwarded-for to prevent client header spoofing', () => {
      const headers = new Headers({
        'x-forwarded-for': 'spoofed.ip.attacker, 5.5.5.5, 6.6.6.6',
      });
      expect(extractClientIp(headers)).toBe('6.6.6.6');
    });

    it('handles trailing commas and spaces in x-forwarded-for cleanly', () => {
      const headers = new Headers({
        'x-forwarded-for': 'spoofed.ip.attacker, 5.5.5.5, 6.6.6.6,   ',
      });
      expect(extractClientIp(headers)).toBe('6.6.6.6');
    });

    it('falls back to unknown-client when no headers present', () => {
      const headers = new Headers();
      expect(extractClientIp(headers)).toBe('unknown-client');
    });
  });

  describe('isRateLimited', () => {
    const baseTime = 1700000000000;

    it('allows attempts within limit', () => {
      const res = isRateLimited(
        MAX_PASSWORD_ATTEMPTS,
        baseTime,
        MAX_PASSWORD_ATTEMPTS,
        RATE_LIMIT_WINDOW_MS,
        baseTime + 10000,
      );
      expect(res.blocked).toBe(false);
      expect(res.retryAfterSeconds).toBe(0);
    });

    it('blocks when attempt count exceeds limit within active window', () => {
      const now = baseTime + 30000; // 30s into 15m window (900s window)
      const res = isRateLimited(MAX_PASSWORD_ATTEMPTS + 1, baseTime, MAX_PASSWORD_ATTEMPTS, RATE_LIMIT_WINDOW_MS, now);
      expect(res.blocked).toBe(true);
      expect(res.retryAfterSeconds).toBe(870); // 900 - 30 = 870
    });

    it('unblocks when rate limit window expires', () => {
      const now = baseTime + RATE_LIMIT_WINDOW_MS + 1000;
      const res = isRateLimited(10, baseTime, MAX_PASSWORD_ATTEMPTS, RATE_LIMIT_WINDOW_MS, now);
      expect(res.blocked).toBe(false);
      expect(res.retryAfterSeconds).toBe(0);
    });
  });

  describe('canClaimRefresh', () => {
    const now = 1700000000000;

    it('does not claim if cache is fresh', () => {
      const freshCachedAt = now - (STALE_TTL_MS - 10000);
      expect(canClaimRefresh(freshCachedAt, null, STALE_TTL_MS, now)).toBe(false);
    });

    it('claims if cache is stale and no active lease exists', () => {
      const staleCachedAt = now - (STALE_TTL_MS + 1000);
      expect(canClaimRefresh(staleCachedAt, null, STALE_TTL_MS, now)).toBe(true);
    });

    it('does not claim if cache is stale but lease is currently held by another worker', () => {
      const staleCachedAt = now - (STALE_TTL_MS + 1000);
      const activeLease = now + 15000;
      expect(canClaimRefresh(staleCachedAt, activeLease, STALE_TTL_MS, now)).toBe(false);
    });

    it('claims if cache is stale and previous lease expired', () => {
      const staleCachedAt = now - (STALE_TTL_MS + 1000);
      const expiredLease = now - 1000;
      expect(canClaimRefresh(staleCachedAt, expiredLease, STALE_TTL_MS, now)).toBe(true);
    });

    it('claims if cache was never populated', () => {
      expect(canClaimRefresh(null, null, STALE_TTL_MS, now)).toBe(true);
    });
  });

  describe('password PBKDF2 hashing and verification', () => {
    it('hashes and successfully verifies a correct password', async () => {
      const password = 'SuperSecretPassword!2026';
      const hash = await hashPasswordPBKDF2(password);

      expect(hash.startsWith('pbkdf2:')).toBe(true);
      expect(hash.split(':')).toHaveLength(3);

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('rejects an incorrect password', async () => {
      const password = 'CorrectPassword';
      const hash = await hashPasswordPBKDF2(password);

      const isValid = await verifyPassword('WrongPassword', hash);
      expect(isValid).toBe(false);
    });

    it('rejects legacy static-salt SHA-256 hashes (dropped in IT-153)', async () => {
      const legacyHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const isValid = await verifyPassword('mypassword', legacyHash);
      expect(isValid).toBe(false);
    });

    it('rejects malformed hash formats', async () => {
      expect(await verifyPassword('foo', 'pbkdf2:incomplete')).toBe(false);
      expect(await verifyPassword('foo', 'pbkdf2::')).toBe(false);
      expect(await verifyPassword('foo', '')).toBe(false);
    });
  });

  describe('computeClientIpHash', () => {
    it('produces a deterministic SHA-256 hex digest', async () => {
      const hash1 = await computeClientIpHash('192.168.1.100');
      const hash2 = await computeClientIpHash('192.168.1.100');
      const hash3 = await computeClientIpHash('10.0.0.1');

      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
    });

    it('handles empty string gracefully', async () => {
      const hash = await computeClientIpHash('');
      expect(hash).toHaveLength(64);
    });
  });

  describe('parseStartDate', () => {
    it('parses ISO format start: YYYY-MM-DD', () => {
      expect(parseStartDate('start: 2026-05-15')).toBe('2026-05-15');
      expect(parseStartDate('Notes\nstart: 2026-12-01\nmore notes')).toBe('2026-12-01');
      expect(parseStartDate('START: 2026-01-05')).toBe('2026-01-05');
      expect(parseStartDate('start: 2024-02-29')).toBe('2024-02-29'); // Leap year
    });

    it('parses legacy format start: DD-MM-YY', () => {
      expect(parseStartDate('start: 15-05-26')).toBe('2026-05-15');
      expect(parseStartDate('start: 01-12-25')).toBe('2025-12-01');
      expect(parseStartDate('Plan:\nStart: 09-02-27')).toBe('2027-02-09');
      expect(parseStartDate('start: 29-02-24')).toBe('2024-02-29'); // Leap year
    });

    it('validates calendar dates and rejects invalid leap years or impossible days', () => {
      expect(parseStartDate('start: 2026-02-31')).toBeNull(); // Impossible Feb 31
      expect(parseStartDate('start: 31-02-26')).toBeNull();
      expect(parseStartDate('start: 2026-04-31')).toBeNull(); // April only has 30 days
      expect(parseStartDate('start: 31-04-26')).toBeNull();
      expect(parseStartDate('start: 2025-02-29')).toBeNull(); // 2025 is not a leap year
      expect(parseStartDate('start: 29-02-25')).toBeNull();
      expect(parseStartDate('start: 04-05-2026')).toBeNull(); // 4-digit year in DD-MM-YYYY doesn't match legacy DD-MM-YY
    });

    it('returns null for invalid dates or non-matching strings', () => {
      expect(parseStartDate('start: 32-05-26')).toBeNull();
      expect(parseStartDate('start: 15-13-26')).toBeNull();
      expect(parseStartDate('start: 2026-13-01')).toBeNull();
      expect(parseStartDate('start: 2026-05-32')).toBeNull();
      expect(parseStartDate('No start tag here')).toBeNull();
      expect(parseStartDate('')).toBeNull();
      expect(parseStartDate(null)).toBeNull();
      expect(parseStartDate(undefined)).toBeNull();
    });
  });

  describe('sanitizeTask', () => {
    it('strips raw description and url while preserving assignee and existing startDate', () => {
      const task = {
        id: 'ENG-101',
        uuid: 'uuid-1',
        title: 'Backend architecture redesign',
        description: 'Confidential internal client requirements and architecture details',
        due: '2026-06-30',
        startDate: '2026-06-01',
        priorityVal: 1,
        priority: 'Urgent',
        status: 'In Progress',
        statusType: 'started',
        assignee: 'Alice Smith',
        url: 'https://linear.app/myorg/issue/ENG-101',
        teamId: 'team-1',
        blocks: ['ENG-102'],
        blockedBy: [],
        progress: 50,
        totalChildren: 2,
        completedChildren: 1,
        completedAt: undefined,
        isDueImplicit: false,
        parentId: null,
      };

      const sanitized = sanitizeTask(task);

      expect(sanitized.description).toBe('');
      expect(sanitized.url).toBe('');
      expect(sanitized.assignee).toBe('Alice Smith');
      expect(sanitized.startDate).toBe('2026-06-01');
      expect(sanitized.due).toBe('2026-06-30');
      expect(sanitized.id).toBe('ENG-101');
      expect(sanitized.title).toBe('Backend architecture redesign');
      expect(sanitized.blocks).toEqual(['ENG-102']);
    });

    it('creates new snapshots with startDate parsed from description while description and url are stripped and assignee kept', () => {
      // Simulates mapNode in fetchLinearData when creating fresh snapshots
      const rawLinearNode = {
        id: 'issue-uuid-1',
        identifier: 'ENG-500',
        title: 'Confidential Milestone Task',
        description: 'Design doc: https://notion.so/secret\nstart: 2026-06-15\nInternal notes',
        dueDate: '2026-06-30',
        priority: 1,
        url: 'https://linear.app/company/issue/ENG-500',
        assignee: { name: 'Sarah Connor' },
      };

      const mappedTask = {
        id: rawLinearNode.identifier,
        uuid: rawLinearNode.id,
        title: rawLinearNode.title,
        description: '', // stripped before persisting
        due: rawLinearNode.dueDate,
        startDate: parseStartDate(rawLinearNode.description), // computed BEFORE stripping description
        priorityVal: rawLinearNode.priority,
        priority: 'Urgent',
        status: 'In Progress',
        statusType: 'started',
        assignee: rawLinearNode.assignee?.name || 'Unassigned',
        url: '', // stripped before persisting
        blocks: [],
        blockedBy: [],
      };

      expect(mappedTask.startDate).toBe('2026-06-15');
      expect(mappedTask.description).toBe('');
      expect(mappedTask.url).toBe('');
      expect(mappedTask.assignee).toBe('Sarah Connor');
    });

    it('extracts startDate from description if task.startDate is null before redacting description', () => {
      const task = {
        id: 'ENG-102',
        title: 'API endpoint integration',
        description: 'Internal documentation: start: 10-04-26 with private tokens',
        due: '2026-04-20',
        startDate: null,
        assignee: 'Bob Jones',
        url: 'https://linear.app/myorg/issue/ENG-102',
      };

      const sanitized = sanitizeTask(task);

      expect(sanitized.startDate).toBe('2026-04-10');
      expect(sanitized.description).toBe('');
      expect(sanitized.url).toBe('');
      expect(sanitized.assignee).toBe('Bob Jones');
    });

    it('handles non-object inputs gracefully', () => {
      expect(sanitizeTask(null as unknown as Record<string, unknown>)).toBeNull();
      expect(sanitizeTask(undefined as unknown as Record<string, unknown>)).toBeUndefined();
    });
  });

  describe('sanitizeMilestone', () => {
    it('strips description and url from milestones while preserving id, name, targetDate', () => {
      const milestone = {
        id: 'milestone-1',
        name: 'V1 Launch',
        targetDate: '2026-08-01',
        description: 'Internal release targets and confidential launch scope',
        url: 'https://linear.app/workspace/milestone/1',
        sortOrder: 1,
      };

      const sanitized = sanitizeMilestone(milestone);

      expect(sanitized.description).toBe('');
      expect(sanitized.url).toBe('');
      expect(sanitized.id).toBe('milestone-1');
      expect(sanitized.name).toBe('V1 Launch');
      expect(sanitized.targetDate).toBe('2026-08-01');
      expect(sanitized.sortOrder).toBe(1);
    });

    it('handles non-object inputs gracefully', () => {
      expect(sanitizeMilestone(null as unknown as Record<string, unknown>)).toBeNull();
      expect(sanitizeMilestone(undefined as unknown as Record<string, unknown>)).toBeUndefined();
    });
  });

  describe('sanitizeCachedRoadmapData', () => {
    it('sanitizes tasks, doneTasks, unscheduledTasks, externalTasks, externalUnscheduledTasks, and milestones in cached data', () => {
      const cached = {
        projectName: 'Secret Roadmap',
        tasks: [
          {
            id: 'ENG-1',
            title: 'Task 1',
            description: 'Internal description 1',
            url: 'https://linear.app/team/issue/ENG-1',
            assignee: 'Alice',
            due: '2026-06-01',
            startDate: '2026-05-01',
          },
        ],
        doneTasks: [
          {
            id: 'ENG-2',
            title: 'Task 2',
            description: 'Internal description 2',
            url: 'https://linear.app/team/issue/ENG-2',
            assignee: 'Bob',
            due: '2026-04-01',
            startDate: null,
          },
        ],
        unscheduledTasks: [
          {
            id: 'ENG-3',
            title: 'Task 3',
            description: 'Internal description 3 start: 2026-07-01',
            url: 'https://linear.app/team/issue/ENG-3',
            assignee: 'Charlie',
            due: '2026-07-15',
            startDate: null,
          },
        ],
        externalTasks: [
          {
            id: 'EXT-1',
            title: 'External dependency',
            description: 'Internal cross-team notes',
            url: 'https://linear.app/other/issue/EXT-1',
            assignee: 'External User',
            due: '2026-06-15',
            startDate: null,
          },
        ],
        externalUnscheduledTasks: [
          {
            id: 'EXT-2',
            title: 'External backlog item',
            description: 'Confidential dependency notes',
            url: 'https://linear.app/other/issue/EXT-2',
            assignee: 'Unassigned',
            due: '2026-06-20',
            startDate: null,
          },
        ],
        milestones: [
          {
            id: 'm-1',
            name: 'Alpha Release',
            description: 'Internal release milestones notes',
            url: 'https://linear.app/team/milestone/m-1',
          },
        ],
        customOrder: ['uuid-1', 'uuid-2'],
      };

      const result = sanitizeCachedRoadmapData(cached);

      expect(result.projectName).toBe('Secret Roadmap');
      expect(result.customOrder).toEqual(['uuid-1', 'uuid-2']);

      expect(result.tasks[0].description).toBe('');
      expect(result.tasks[0].url).toBe('');
      expect(result.tasks[0].assignee).toBe('Alice');
      expect(result.tasks[0].startDate).toBe('2026-05-01');

      expect(result.doneTasks[0].description).toBe('');
      expect(result.doneTasks[0].url).toBe('');
      expect(result.doneTasks[0].assignee).toBe('Bob');
      expect(result.doneTasks[0].startDate).toBeNull();

      expect(result.unscheduledTasks[0].description).toBe('');
      expect(result.unscheduledTasks[0].url).toBe('');
      expect(result.unscheduledTasks[0].assignee).toBe('Charlie');
      expect(result.unscheduledTasks[0].startDate).toBe('2026-07-01');

      expect(result.externalTasks[0].description).toBe('');
      expect(result.externalTasks[0].url).toBe('');
      expect(result.externalTasks[0].assignee).toBe('External User');

      expect(result.externalUnscheduledTasks[0].description).toBe('');
      expect(result.externalUnscheduledTasks[0].url).toBe('');
      expect(result.externalUnscheduledTasks[0].assignee).toBe('Unassigned');

      expect(result.milestones[0].description).toBe('');
      expect(result.milestones[0].url).toBe('');
      expect(result.milestones[0].name).toBe('Alpha Release');
    });

    it('sanitizes legacy pre-cached database rows on get without leaking raw descriptions or URLs', () => {
      // Represents a legacy row stored in Postgres before IT-154
      const legacyCachedData = {
        projectName: 'Legacy Project',
        tasks: [
          {
            id: 'ENG-200',
            uuid: 'legacy-uuid-1',
            title: 'Legacy task',
            description: 'Legacy internal details start: 15-08-25 - credentials in 1Password',
            url: 'https://linear.app/workspace/issue/ENG-200',
            due: '2025-08-30',
            startDate: null,
            priorityVal: 2,
            priority: 'High',
            status: 'Todo',
            statusType: 'unstarted',
            assignee: 'Alice Engineer',
          },
        ],
      };

      const sanitized = sanitizeCachedRoadmapData(legacyCachedData);

      expect(sanitized.tasks[0].description).toBe('');
      expect(sanitized.tasks[0].url).toBe('');
      expect(sanitized.tasks[0].assignee).toBe('Alice Engineer');
      expect(sanitized.tasks[0].startDate).toBe('2025-08-15');
      expect(sanitized.tasks[0].due).toBe('2025-08-30');
    });

    it('handles non-object and empty inputs safely', () => {
      expect(sanitizeCachedRoadmapData(null as unknown as Record<string, unknown>)).toBeNull();
      expect(sanitizeCachedRoadmapData(undefined as unknown as Record<string, unknown>)).toBeUndefined();
      expect(sanitizeCachedRoadmapData({})).toEqual({});
    });
  });
});
