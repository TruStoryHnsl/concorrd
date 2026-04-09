import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  validateChartAttachment,
  ChartRenderer,
} from "../MessageContent";

// react-chartjs-2 reaches for a real Canvas at render time, which jsdom
// doesn't implement. Mock the three chart components we render as simple
// stubs that surface their `data` prop as a JSON string — that's enough to
// assert the happy-path render was reached without pulling in canvas.
vi.mock("react-chartjs-2", () => ({
  Bar: ({ data }: { data: unknown }) => (
    <div data-testid="chart-stub" data-chart-type="bar">
      {JSON.stringify(data)}
    </div>
  ),
  Line: ({ data }: { data: unknown }) => (
    <div data-testid="chart-stub" data-chart-type="line">
      {JSON.stringify(data)}
    </div>
  ),
  Pie: ({ data }: { data: unknown }) => (
    <div data-testid="chart-stub" data-chart-type="pie">
      {JSON.stringify(data)}
    </div>
  ),
}));

// chart.js registers a bunch of scales/elements at module load. Neuter the
// register call to keep the mock clean — the stubs don't need it.
vi.mock("chart.js", () => ({
  Chart: { register: () => {} },
  CategoryScale: {},
  LinearScale: {},
  BarElement: {},
  LineElement: {},
  PointElement: {},
  ArcElement: {},
  Title: {},
  Tooltip: {},
  Legend: {},
}));

function goodBarPayload() {
  return {
    type: "bar" as const,
    data: {
      labels: ["Q1", "Q2", "Q3"],
      datasets: [{ label: "Revenue", data: [10, 20, 30] }],
    },
  };
}

describe("validateChartAttachment", () => {
  it("rejects payloads with an empty datasets array", () => {
    const result = validateChartAttachment({
      type: "bar",
      data: { labels: ["A", "B"], datasets: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/datasets.*non-empty/i);
    }
  });

  it("rejects payloads where a dataset's data length does not match labels length", () => {
    const result = validateChartAttachment({
      type: "line",
      data: {
        labels: ["Mon", "Tue", "Wed"],
        datasets: [{ label: "Visits", data: [100, 200] }], // 2 ≠ 3
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/length/i);
      expect(result.error).toContain("2");
      expect(result.error).toContain("3");
    }
  });

  it("rejects NaN values in dataset data", () => {
    const result = validateChartAttachment({
      type: "bar",
      data: {
        labels: ["A", "B"],
        datasets: [{ data: [1, NaN] }],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/finite/i);
    }
  });

  it("rejects Infinity values in dataset data", () => {
    const result = validateChartAttachment({
      type: "bar",
      data: {
        labels: ["A", "B"],
        datasets: [{ data: [1, Infinity] }],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/finite/i);
    }
  });

  it("accepts a well-formed bar payload", () => {
    const result = validateChartAttachment(goodBarPayload());
    expect(result.ok).toBe(true);
  });
});

describe("<ChartRenderer />", () => {
  it("renders a bar chart from a valid payload", () => {
    render(<ChartRenderer raw={goodBarPayload()} />);
    const stub = screen.getByTestId("chart-stub");
    expect(stub).toHaveAttribute("data-chart-type", "bar");
    expect(stub.textContent).toContain("Q1");
  });

  it("renders a line chart from a valid payload", () => {
    render(
      <ChartRenderer
        raw={{
          type: "line",
          data: {
            labels: ["Jan", "Feb", "Mar"],
            datasets: [{ label: "Users", data: [5, 15, 25] }],
          },
        }}
      />,
    );
    const stub = screen.getByTestId("chart-stub");
    expect(stub).toHaveAttribute("data-chart-type", "line");
    expect(stub.textContent).toContain("Jan");
  });

  it("renders a pie chart from a valid payload", () => {
    render(
      <ChartRenderer
        raw={{
          type: "pie",
          data: {
            labels: ["Alpha", "Beta", "Gamma"],
            datasets: [{ data: [30, 50, 20] }],
          },
        }}
      />,
    );
    const stub = screen.getByTestId("chart-stub");
    expect(stub).toHaveAttribute("data-chart-type", "pie");
    expect(stub.textContent).toContain("Alpha");
  });

  it("renders the InvalidChart fallback pill when the payload is malformed", () => {
    render(<ChartRenderer raw={{ type: "bogus" }} />);
    expect(screen.queryByTestId("chart-stub")).not.toBeInTheDocument();
    expect(screen.getByText(/Invalid chart/i)).toBeInTheDocument();
  });

  it("renders the InvalidChart fallback pill when dataset data has NaN", () => {
    render(
      <ChartRenderer
        raw={{
          type: "bar",
          data: {
            labels: ["A", "B"],
            datasets: [{ data: [1, NaN] }],
          },
        }}
      />,
    );
    expect(screen.queryByTestId("chart-stub")).not.toBeInTheDocument();
    expect(screen.getByText(/Invalid chart/i)).toBeInTheDocument();
  });
});
