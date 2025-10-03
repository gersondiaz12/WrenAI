import microCors from 'micro-cors';
import { NextApiRequest, NextApiResponse, PageConfig } from 'next';
import { ApolloServer } from 'apollo-server-micro';
import { typeDefs } from '@server';
import resolvers from '@server/resolvers';
import { IContext } from '@server/types';
import { GraphQLError } from 'graphql';
import { getLogger } from '@server/utils';
import { getConfig } from '@server/config';
import { ModelService } from '@server/services/modelService';
import {
  defaultApolloErrorHandler,
  GeneralErrorCodes,
} from '@/apollo/server/utils/error';
import { TelemetryEvent } from '@/apollo/server/telemetry/telemetry';
import { components } from '@/common';

const serverConfig = getConfig();
const logger = getLogger('APOLLO');
logger.level = 'debug';

const cors = microCors();

export const config: PageConfig = {
  api: {
    bodyParser: false,
  },
};

const bootstrapServer = async () => {
  const {
    telemetry,

    // repositories
    projectRepository,
    modelRepository,
    modelColumnRepository,
    relationRepository,
    deployLogRepository,
    viewRepository,
    schemaChangeRepository,
    learningRepository,
    modelNestedColumnRepository,
    dashboardRepository,
    dashboardItemRepository,
    sqlPairRepository,
    instructionRepository,
    apiHistoryRepository,
    dashboardItemRefreshJobRepository,
    // adaptors
    wrenEngineAdaptor,
    ibisAdaptor,
    wrenAIAdaptor,

    // services
    projectService,
    queryService,
    askingService,
    deployService,
    mdlService,
    dashboardService,
    sqlPairService,

    instructionService,
    // background trackers
    projectRecommendQuestionBackgroundTracker,
    threadRecommendQuestionBackgroundTracker,
    dashboardCacheBackgroundTracker,
  } = components;

  const modelService = new ModelService({
    projectService,
    modelRepository,
    modelColumnRepository,
    relationRepository,
    viewRepository,
    mdlService,
    wrenEngineAdaptor,
    queryService,
  });

  // initialize services
  await Promise.all([
    askingService.initialize(),
    projectRecommendQuestionBackgroundTracker.initialize(),
    threadRecommendQuestionBackgroundTracker.initialize(),
  ]);

  const apolloServer: ApolloServer = new ApolloServer({
    typeDefs,
    resolvers,
    formatError: (error: GraphQLError) => {
      // stop print error stacktrace of dry run error
      if (error.extensions?.code === GeneralErrorCodes.DRY_RUN_ERROR) {
        return defaultApolloErrorHandler(error);
      }

      // print error stacktrace of graphql error
      const stacktrace = error.extensions?.exception?.stacktrace;
      if (stacktrace) {
        logger.error(stacktrace.join('\n'));
      }

      // print original error stacktrace
      const originalError = error.extensions?.originalError as Error;
      if (originalError) {
        logger.error(`== original error ==`);
        // error may not have stack, so print error message if stack is not available
        logger.error(originalError.stack || originalError.message);
      }

      // telemetry: capture internal server error
      if (error.extensions?.code === GeneralErrorCodes.INTERNAL_SERVER_ERROR) {
        telemetry.sendEvent(
          TelemetryEvent.GRAPHQL_ERROR,
          {
            originalErrorStack: originalError?.stack,
            originalErrorMessage: originalError?.message,
            errorMessage: error.message,
          },
          error.extensions?.service,
          false,
        );
      }
      return defaultApolloErrorHandler(error);
    },
    introspection: process.env.NODE_ENV !== 'production',
  context: (): IContext => ({
      config: serverConfig,
      telemetry,
      // adaptor
      wrenEngineAdaptor,
      ibisServerAdaptor: ibisAdaptor,
      wrenAIAdaptor,
      // services
      projectService,
      modelService,
      mdlService,
      deployService,
      askingService,
      queryService,
      dashboardService,
      sqlPairService,
      instructionService,
      // repository
      projectRepository,
      modelRepository,
      modelColumnRepository,
      modelNestedColumnRepository,
      relationRepository,
      viewRepository,
      deployRepository: deployLogRepository,
      schemaChangeRepository,
      learningRepository,
      dashboardRepository,
      dashboardItemRepository,
      sqlPairRepository,
      instructionRepository,
      apiHistoryRepository,
      dashboardItemRefreshJobRepository,
      // background trackers
      projectRecommendQuestionBackgroundTracker,
      threadRecommendQuestionBackgroundTracker,
      dashboardCacheBackgroundTracker,
      // Note: when running inside Next API route the request object is available
      // we pass a minimal `req` placeholder here; the real request is attached
      // by the handler below where we have access to the NextApiRequest.
    }),
  });
  await apolloServer.start();
  return apolloServer;
};

const startServer = bootstrapServer();

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const apolloServer = await startServer;
  // Wrap the original createHandler so we can inject the req into context and
  // derive a simple isAdmin flag from either an admin header or ADMIN_TOKEN env.
  const originalHandler = apolloServer.createHandler({ path: '/api/graphql' });
  // attach a small middleware to set ctx from header
  // The Apollo Server instance will call context() defined above; to allow
  // per-request data we rely on a header value 'x-wren-admin-token'.
  const adminHeader = req.headers['x-wren-admin-token'] as string | undefined;
  // simple check: match header against ADMIN_TOKEN env var if present
  const isAdmin = !!(
    adminHeader && process.env.ADMIN_TOKEN && adminHeader === process.env.ADMIN_TOKEN
  );
  // put isAdmin on req so resolvers that read ctx.req can see it
  // Note: Apollo Server attaches request to context automatically in some setups;
  // here we set a temporary property so resolvers can check process.env or ctx.req.headers.
  (req as any).__isAdmin = isAdmin;
  await originalHandler(req, res);
};

export default cors((req: NextApiRequest, res: NextApiResponse) =>
  req.method === 'OPTIONS' ? res.status(200).end() : handler(req, res),
);
