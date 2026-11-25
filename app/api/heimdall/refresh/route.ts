import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/db';
import { getAuthenticatedUserId } from '@/src/lib/auth';
import { env } from '@/src/lib/env';
import { getStreamlinePortals, importStreamlineLogsFromAPI, type ImportResult } from '@/src/lib/streamline-import';

export const runtime = 'nodejs';

/**
 * Refresh Streamline logs directly from each configured Streamline portal's API into Supabase.
 * Fetches directly from the Streamline API instead of local files.
 */
export async function POST() {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch directly from each Streamline portal's API and import
    const result: ImportResult = {
      mbuLogs: { created: 0, skipped: 0 },
      serverSideRules: { created: 0, skipped: 0 },
      traces: { created: 0, skipped: 0 },
      filesProcessed: 0,
      totalRecords: 0,
      errors: [],
    };
    // Older records are pruned by the log poller, so importing them is wasted work.
    const notBefore = new Date(Date.now() - env.streamlineLogRetentionMs);
    for (const portal of getStreamlinePortals()) {
      try {
        const r = await importStreamlineLogsFromAPI(prisma, {
          environment: portal.environment,
          host: portal.host,
          token: portal.token,
          apiName: portal.apiName,
          limit: 50, // Fetch last 50 records per type
          notBefore,
        });
        for (const key of ['mbuLogs', 'serverSideRules', 'traces'] as const) {
          result[key].created += r[key].created;
          result[key].skipped += r[key].skipped;
        }
        result.filesProcessed += r.filesProcessed;
        result.totalRecords += r.totalRecords;
        result.errors.push(...r.errors.map((e) => `${portal.name}: ${e}`));
      } catch (err) {
        // One portal failing must not hide what the others imported.
        result.errors.push(`${portal.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return NextResponse.json({
      success: true,
      user: user.emailOrUsername,
      limit: 50,
      ...result,
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
