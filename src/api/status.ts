import type { Context } from "hono";
import type { Env } from "../env";

type ComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage";

type ComponentDefinition = {
  id: string;
  name: string;
  group: string;
  description: string;
  endpoint: string;
};

type StatusComponent = ComponentDefinition & {
  status: ComponentStatus;
  checked_at: string;
  updated_at: string;
};

type RegionDefinition = {
  id: string;
  name: string;
  group: string;
  description: string;
  endpoint: string;
  latitude: number;
  longitude: number;
};

type StatusRegion = RegionDefinition & {
  status: ComponentStatus;
  checked_at: string;
  updated_at: string;
};

type StatusIncident = {
  id: string;
  name: string;
  status: string;
  impact: "minor" | "major" | "critical";
  created_at: string;
  updated_at: string;
  components: string[];
  component_names: string[];
  incident_updates: Array<{
    status: string;
    body: string;
    created_at: string;
  }>;
};

const COMPONENTS: ComponentDefinition[] = [
  {
    id: "website",
    name: "W7S website",
    group: "Public delivery",
    description: "Landing page and public status surface on www.w7s.io.",
    endpoint: "www.w7s.io"
  },
  {
    id: "docs",
    name: "Documentation",
    group: "Public delivery",
    description: "Docusaurus documentation served from www.w7s.io/docs.",
    endpoint: "www.w7s.io/docs"
  },
  {
    id: "live-routing",
    name: "W7S Live routing",
    group: "Public delivery",
    description: "Public app routing on owner.w7s.cloud/repo paths.",
    endpoint: "*.w7s.cloud"
  },
  {
    id: "custom-domains",
    name: "Custom domains",
    group: "Public delivery",
    description: "Custom domain routing for W7S deployments.",
    endpoint: "custom domains"
  },
  {
    id: "cloud-api",
    name: "W7S Cloud API",
    group: "Control plane",
    description: "Deploy intake, health checks, and platform API routing.",
    endpoint: "w7s.cloud/api"
  },
  {
    id: "usage-observability",
    name: "Usage and observability APIs",
    group: "Control plane",
    description: "Usage limits, analytics, and log APIs with auth enforcement.",
    endpoint: "w7s.cloud/api/v1"
  },
  {
    id: "native-backends",
    name: "Native backend runtime",
    group: "Runtime features",
    description: "JavaScript and TypeScript backend request dispatch.",
    endpoint: "native backends"
  },
  {
    id: "stateful-objects",
    name: "Stateful objects",
    group: "Runtime features",
    description: "Persistent stateful coordination and storage bindings.",
    endpoint: "stateful objects"
  },
  {
    id: "backend-rpc",
    name: "Backend RPC",
    group: "Runtime features",
    description: "Internal backend-to-backend service calls.",
    endpoint: "W7S RPC"
  },
  {
    id: "queues",
    name: "Background queues",
    group: "Runtime features",
    description: "Managed queue delivery to JavaScript and TypeScript backends.",
    endpoint: "W7S queues"
  },
  {
    id: "schedules",
    name: "Cron schedules",
    group: "Runtime features",
    description: "Scheduled background dispatch to deployed backends.",
    endpoint: "W7S schedules"
  },
  {
    id: "workflows",
    name: "Durable workflows",
    group: "Runtime features",
    description: "Workflow instance dispatch and status retrieval.",
    endpoint: "W7S workflows"
  }
];

const REGIONS: RegionDefinition[] = [
  {
    id: "north-america",
    name: "North America",
    group: "W7S Edge",
    description: "Regional public routing for North American traffic.",
    endpoint: "North America edge",
    latitude: 39,
    longitude: -98
  },
  {
    id: "latin-america",
    name: "Latin America",
    group: "W7S Edge",
    description: "Regional public routing for Latin American traffic.",
    endpoint: "Latin America edge",
    latitude: -15,
    longitude: -60
  },
  {
    id: "europe",
    name: "Europe",
    group: "W7S Edge",
    description: "Regional public routing for European traffic.",
    endpoint: "Europe edge",
    latitude: 50,
    longitude: 10
  },
  {
    id: "africa",
    name: "Africa",
    group: "W7S Edge",
    description: "Regional public routing for African traffic.",
    endpoint: "Africa edge",
    latitude: 1,
    longitude: 20
  },
  {
    id: "asia-pacific",
    name: "Asia Pacific",
    group: "W7S Edge",
    description: "Regional public routing for Asia Pacific traffic.",
    endpoint: "Asia Pacific edge",
    latitude: 23,
    longitude: 105
  },
  {
    id: "oceania",
    name: "Oceania",
    group: "W7S Edge",
    description: "Regional public routing for Oceania traffic.",
    endpoint: "Oceania edge",
    latitude: -25,
    longitude: 134
  }
];

const validStatus = (status: unknown): status is ComponentStatus =>
  status === "operational" ||
  status === "degraded_performance" ||
  status === "partial_outage" ||
  status === "major_outage";

const validIncidentImpact = (impact: unknown): impact is StatusIncident["impact"] =>
  impact === "minor" || impact === "major" || impact === "critical";

const validIncident = (incident: unknown): incident is StatusIncident => {
  if (!incident || typeof incident !== "object") return false;
  const candidate = incident as Partial<StatusIncident>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.status === "string" &&
    validIncidentImpact(candidate.impact) &&
    typeof candidate.created_at === "string" &&
    typeof candidate.updated_at === "string" &&
    Array.isArray(candidate.components) &&
    Array.isArray(candidate.component_names) &&
    Array.isArray(candidate.incident_updates)
  );
};

const parseJson = <T>(raw: string | undefined): T | null => {
  if (!raw?.trim()) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const componentStatusOverrides = (env: Env) => {
  const parsed = parseJson<Record<string, unknown>>(env.W7S_STATUS_COMPONENTS_JSON);
  if (!parsed) return {};

  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, ComponentStatus] =>
      validStatus(entry[1])
    )
  );
};

const regionStatusOverrides = (env: Env) => {
  const parsed = parseJson<Record<string, unknown>>(env.W7S_STATUS_REGIONS_JSON);
  if (!parsed) return {};

  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, ComponentStatus] =>
      validStatus(entry[1])
    )
  );
};

const incidentOverrides = (env: Env) => {
  const parsed = parseJson<unknown>(env.W7S_STATUS_INCIDENTS_JSON);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(validIncident);
};

const statusHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8"
};

const statusRank: Record<ComponentStatus, number> = {
  operational: 0,
  degraded_performance: 1,
  partial_outage: 2,
  major_outage: 3
};

const componentImpact = (status: ComponentStatus) => {
  if (status === "major_outage") return "major";
  if (status === "partial_outage") return "minor";
  if (status === "degraded_performance") return "minor";
  return "none";
};

const buildComponents = (env: Env, checkedAt: string): StatusComponent[] => {
  const overrides = componentStatusOverrides(env);

  return COMPONENTS.map((component) => ({
    ...component,
    status: overrides[component.id] ?? "operational",
    checked_at: checkedAt,
    updated_at: checkedAt
  }));
};

const buildRegions = (env: Env, checkedAt: string): StatusRegion[] => {
  const overrides = regionStatusOverrides(env);

  return REGIONS.map((region) => ({
    ...region,
    status: overrides[region.id] ?? "operational",
    checked_at: checkedAt,
    updated_at: checkedAt
  }));
};

const overallStatus = (
  resources: Array<{ status: ComponentStatus }>,
  incidents: StatusIncident[]
) => {
  const worstResource = resources.reduce<ComponentStatus>(
    (worst, resource) =>
      statusRank[resource.status] > statusRank[worst] ? resource.status : worst,
    "operational"
  );
  const hasCriticalIncident = incidents.some((incident) => incident.impact === "critical");
  const hasMajorIncident = incidents.some((incident) => incident.impact === "major");
  const hasMinorIncident = incidents.some((incident) => incident.impact === "minor");

  if (hasCriticalIncident) {
    return {
      indicator: "critical",
      description: "Critical outage detected"
    };
  }

  if (worstResource === "major_outage") {
    return {
      indicator: "major",
      description: "Active outage detected"
    };
  }

  if (hasMajorIncident || worstResource === "partial_outage") {
    return {
      indicator: "minor",
      description: "Partial outage detected"
    };
  }

  if (hasMinorIncident || worstResource === "degraded_performance") {
    return {
      indicator: "minor",
      description: "Some systems degraded"
    };
  }

  return {
    indicator: "none",
    description: "All systems operational"
  };
};

const resourceIncidents = (
  resources: Array<{ id: string; name: string; status: ComponentStatus }>,
  checkedAt: string,
  options: { id: string; name: string; body: string }
): StatusIncident[] => {
  const impacted = resources.filter((resource) => resource.status !== "operational");
  if (!impacted.length) return [];

  const impact = impacted.reduce<"minor" | "major">((worst, resource) => {
    const nextImpact = componentImpact(resource.status);
    return nextImpact === "major" ? "major" : worst;
  }, "minor");

  return [
    {
      id: `${options.id}-${checkedAt}`,
      name: options.name,
      status: "investigating",
      impact,
      created_at: checkedAt,
      updated_at: checkedAt,
      components: impacted.map((resource) => resource.id),
      component_names: impacted.map((resource) => resource.name),
      incident_updates: [
        {
          status: "investigating",
          body: options.body,
          created_at: checkedAt
        }
      ]
    }
  ];
};

const statusSummary = (env: Env) => {
  const checkedAt = new Date().toISOString();
  const components = buildComponents(env, checkedAt);
  const regions = buildRegions(env, checkedAt);
  const incidents = [
    ...incidentOverrides(env),
    ...resourceIncidents(components, checkedAt, {
      id: "component-status",
      name: "W7S component status update",
      body: "One or more W7S components is currently not marked operational."
    }),
    ...resourceIncidents(regions, checkedAt, {
      id: "region-status",
      name: "W7S edge region status update",
      body: "One or more W7S edge regions is currently not marked operational."
    })
  ];

  return {
    page: {
      id: "w7s",
      name: "W7S",
      url: "https://www.w7s.io/status",
      time_zone: "Etc/UTC",
      updated_at: checkedAt
    },
    status: overallStatus([...components, ...regions], incidents),
    components,
    regions,
    incidents,
    scheduled_maintenances: []
  };
};

export const handleStatusOptions = () =>
  new Response(null, {
    status: 204,
    headers: statusHeaders
  });

export const handleStatusGet = async (c: Context<{ Bindings: Env }>) =>
  new Response(JSON.stringify(statusSummary(c.env)), {
    status: 200,
    headers: statusHeaders
  });
