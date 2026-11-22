import { create } from "zustand";

/** A request waiting on its answer; `null` is what it resolves to when it is dismissed or replaced. */
export type Pending<Request, Answer> = Request & { resolve: (answer: Answer | null) => void };

/**
 * A question put from code and answered by a dialog: `ask` resolves to the answer, `settle` is what the dialog
 * calls. A second `ask` while one is open resolves the first to `null` and takes its place.
 */
export function createPrompt<Request extends object, Answer>() {
  const useStore = create<{ request: Pending<Request, Answer> | null }>(() => ({ request: null }));
  return {
    useStore,
    ask: (request: Request) =>
      new Promise<Answer | null>((resolve) => {
        useStore.getState().request?.resolve(null);
        useStore.setState({ request: { ...request, resolve } });
      }),
    settle: (answer: Answer | null) => {
      useStore.getState().request?.resolve(answer);
      useStore.setState({ request: null });
    }
  };
}

/** The same, with one question open per window at a time; the page's own, or any window's left out, is under "". */
export function createScopedPrompt<Request extends object, Answer>() {
  const useStore = create<{ requests: Record<string, Pending<Request, Answer>> }>(() => ({ requests: {} }));
  return {
    useStore,
    ask: (scope: string | null | undefined, request: Request) =>
      new Promise<Answer | null>((resolve) => {
        const key = scope ?? "";
        useStore.getState().requests[key]?.resolve(null);
        useStore.setState(({ requests }) => ({ requests: { ...requests, [key]: { ...request, resolve } } }));
      }),
    settle: (scope: string, answer: Answer | null) => {
      const { [scope]: request, ...rest } = useStore.getState().requests;
      request?.resolve(answer);
      useStore.setState({ requests: rest });
    }
  };
}
