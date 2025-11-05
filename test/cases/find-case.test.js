import { MongoClient } from "mongodb";
import { env } from "node:process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { caseData1, caseData2 } from "../fixtures/case.js";
import { createWorkflow } from "../helpers/workflows.js";
import { wreck } from "../helpers/wreck.js";

let cases;

let client;

beforeAll(async () => {
  client = await MongoClient.connect(env.MONGO_URI);
  cases = client.db().collection("cases");
});

afterAll(async () => {
  await client.close(true);
});

describe("GET /cases/{caseId}", () => {
  beforeEach(async () => {
    await createWorkflow();
  });

  it("finds a case by id", async () => {
    const { insertedIds } = await cases.insertMany([
      {
        ...caseData1,
        dateReceived: new Date(caseData1.dateReceived),
      },
      {
        ...caseData2,
        dateReceived: new Date(caseData2.dateReceived),
      },
    ]);

    const caseId = insertedIds[1].toHexString();

    const response = await wreck.get(`/cases/${caseId}`);

    expect(response.res.statusCode).toBe(200);
    expect(response.payload).toEqual({
      ...caseData2,
      _id: caseId,
      dateReceived: new Date(caseData2.dateReceived).toISOString(),
      phases: [
        {
          code: "default",
          name: "Default Phase",
          stages: [
            {
              code: "application-receipt",
              name: "Application Receipt",
              description: "Application received",
              statuses: [],
              actions: [
                {
                  code: "approve",
                  name: "Approve",
                  comment: null,
                },
              ],
              taskGroups: [
                {
                  code: "application-receipt-tasks",
                  name: "Application Receipt tasks",
                  description: "Task group description",
                  tasks: [
                    {
                      code: "simple-review",
                      name: "Simple Review",
                      description: [
                        {
                          component: "heading",
                          level: 2,
                          text: "Simple review task",
                        },
                      ],
                      status: "pending",
                      statusOptions: [],
                      updatedBy: null,
                      requiredRoles: {
                        allOf: ["ROLE_1", "ROLE_2"],
                        anyOf: ["ROLE_3"],
                      },
                    },
                  ],
                },
              ],
            },
            {
              code: "contract",
              name: "Stage for contract management",
              description: "Awaiting agreement",
              statuses: [],
              actions: [],
              taskGroups: [],
            },
          ],
        },
      ],
      timeline: [
        {
          ...caseData2.timeline[0],
          createdBy: {
            id: "System",
            name: "System",
          },
        },
      ],
      banner: {
        summary: {
          createdAt: {
            label: "Created At",
            text: "27 Mar 2025",
            type: "date",
          },
          reference: {
            label: "Reference",
            text: "CASE-REF-2",
            type: "string",
          },
          sbi: {
            label: "SBI",
            text: "SBI001",
            type: "string",
          },
          scheme: {
            label: "Scheme",
            text: "SFI",
            type: "string",
          },
        },
        title: {
          text: "",
          type: "string",
        },
      },
      links: [
        {
          href: `/cases/${caseId}`,
          id: "tasks",
          text: "Tasks",
        },
        {
          href: `/cases/${caseId}/case-details`,
          id: "case-details",
          text: "Case Details",
        },
        {
          href: `/cases/${caseId}/notes`,
          id: "notes",
          text: "Notes",
        },
        {
          href: `/cases/${caseId}/timeline`,
          id: "timeline",
          text: "Timeline",
        },
      ],
      supplementaryData: {},
    });
  });
});
