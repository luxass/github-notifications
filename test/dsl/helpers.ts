/**
 * Shared fixtures for the DSL tests. Plain data only — no imports from
 * src/dsl, so these helpers work from the very first (red) test run.
 *
 * The shape mirrors the schema table in SPEC.md. Your QueryEnvironment
 * must accept these objects structurally.
 */

export interface FixtureEnvironment {
  notification: {
    id: string;
    reason: string;
    unread: boolean;
    title: string;
    type: string;
    updatedAt: Date;
  };
  repo: {
    name: string;
    owner: string;
    fullName: string;
    private: boolean;
    stars: number;
  };
  author: {
    login: string;
    type: string;
  };
  ctx: {
    login: string;
  };
  subject: {
    state: string;
    merged: boolean;
    author: string;
    reviewPending: boolean;
  };
}

/** A dependabot security PR that mentions you. Matches most test rules. */
export function makeMentionEnv(): FixtureEnvironment {
  return {
    notification: {
      id: "1001",
      reason: "mention",
      unread: true,
      title: "Security fix for auth flow",
      type: "PullRequest",
      updatedAt: new Date("2026-09-18T10:00:00.000Z"),
    },
    repo: {
      name: "github-notifications",
      owner: "lucasnorgard",
      fullName: "lucasnorgard/github-notifications",
      private: false,
      stars: 42,
    },
    author: {
      login: "dependabot",
      type: "Bot",
    },
    ctx: {
      login: "lucasnorgard",
    },
    subject: {
      state: "open",
      merged: false,
      author: "dependabot",
      reviewPending: false,
    },
  };
}

/** A quiet digest in someone else's public repo. Matches (almost) nothing. */
export function makeQuietEnv(): FixtureEnvironment {
  return {
    notification: {
      id: "2002",
      reason: "subscribed",
      unread: false,
      title: "Weekly digest",
      type: "Discussion",
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    repo: {
      name: "hello-world",
      owner: "octocat",
      fullName: "octocat/hello-world",
      private: false,
      stars: 5,
    },
    author: {
      login: "octocat",
      type: "User",
    },
    ctx: {
      login: "lucasnorgard",
    },
    subject: {
      state: "open",
      merged: false,
      author: "octocat",
      reviewPending: false,
    },
  };
}
