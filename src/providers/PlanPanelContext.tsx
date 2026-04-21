import { createContext, useContext, type FC, type PropsWithChildren } from 'react';

type PlanPanelContextValue = {
  openPlan: (content: string, filePath?: string) => void;
};

const PlanPanelContext = createContext<PlanPanelContextValue | null>(null);

export const PlanPanelProvider: FC<PropsWithChildren<{ onOpenPlan: (content: string, filePath?: string) => void }>> = ({ onOpenPlan, children }) => {
  return (
    <PlanPanelContext.Provider value={{ openPlan: onOpenPlan }}>
      {children}
    </PlanPanelContext.Provider>
  );
};

export function usePlanPanel(): PlanPanelContextValue | null {
  return useContext(PlanPanelContext);
}
