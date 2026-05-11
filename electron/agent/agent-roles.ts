/**
 * Agent Role Catalog — curated list of role templates for matching.
 *
 * Each entry maps to a markdown file in the msitarzewski/agency-agents repo.
 * Haiku uses these entries (name + description) to match against user descriptions.
 */

export interface AgentRoleEntry {
  /** File path in the repo, e.g. "engineering/engineering-code-reviewer" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Division/category */
  division: string;
  /** One-line description for matching context */
  description: string;
}

export const ROLE_BASE_URL = 'https://raw.githubusercontent.com/msitarzewski/agency-agents/refs/heads/main';

export const AGENT_ROLE_CATALOG: AgentRoleEntry[] = [
  // ── Engineering ────────────────────────────────────────────────────────
  { id: 'engineering/engineering-frontend-developer', name: 'Frontend Developer', division: 'Engineering', description: 'Builds user interfaces with React, CSS, and modern web frameworks' },
  { id: 'engineering/engineering-backend-architect', name: 'Backend Architect', division: 'Engineering', description: 'Designs scalable server-side systems, APIs, and database architectures' },
  { id: 'engineering/engineering-devops-automator', name: 'DevOps Automator', division: 'Engineering', description: 'Automates CI/CD pipelines, infrastructure provisioning, and deployment workflows' },
  { id: 'engineering/engineering-code-reviewer', name: 'Code Reviewer', division: 'Engineering', description: 'Reviews code for quality, performance, maintainability, and best practices' },
  { id: 'engineering/engineering-security-engineer', name: 'Security Engineer', division: 'Engineering', description: 'Identifies vulnerabilities, implements security controls, and hardens systems' },
  { id: 'engineering/engineering-software-architect', name: 'Software Architect', division: 'Engineering', description: 'Designs system architecture, makes technology decisions, and defines patterns' },
  { id: 'engineering/engineering-mobile-app-builder', name: 'Mobile App Builder', division: 'Engineering', description: 'Builds native and cross-platform mobile applications for iOS and Android' },
  { id: 'engineering/engineering-ai-engineer', name: 'AI Engineer', division: 'Engineering', description: 'Builds AI/ML systems, fine-tunes models, and implements intelligent features' },
  { id: 'engineering/engineering-rapid-prototyper', name: 'Rapid Prototyper', division: 'Engineering', description: 'Quickly builds functional prototypes to validate ideas and test concepts' },
  { id: 'engineering/engineering-senior-developer', name: 'Senior Developer', division: 'Engineering', description: 'Full-stack development with deep expertise in system design and mentoring' },
  { id: 'engineering/engineering-database-optimizer', name: 'Database Optimizer', division: 'Engineering', description: 'Optimizes database queries, schemas, indexing, and data storage performance' },
  { id: 'engineering/engineering-technical-writer', name: 'Technical Writer', division: 'Engineering', description: 'Creates clear documentation, API guides, and technical content' },
  { id: 'engineering/engineering-data-engineer', name: 'Data Engineer', division: 'Engineering', description: 'Builds data pipelines, ETL processes, and data warehouse solutions' },
  { id: 'engineering/engineering-sre', name: 'SRE', division: 'Engineering', description: 'Ensures system reliability, monitors uptime, and manages incident response' },

  // ── Design ─────────────────────────────────────────────────────────────
  { id: 'design/design-ui-designer', name: 'UI Designer', division: 'Design', description: 'Creates beautiful, intuitive user interface designs and component systems' },
  { id: 'design/design-ux-researcher', name: 'UX Researcher', division: 'Design', description: 'Conducts user research, usability testing, and synthesizes insights' },
  { id: 'design/design-ux-architect', name: 'UX Architect', division: 'Design', description: 'Designs information architecture, user flows, and interaction patterns' },

  // ── Product ────────────────────────────────────────────────────────────
  { id: 'product/product-product-manager', name: 'Product Manager', division: 'Product', description: 'Defines product strategy, prioritizes features, and drives roadmap decisions' },
  { id: 'product/product-sprint-prioritizer', name: 'Sprint Prioritizer', division: 'Product', description: 'Prioritizes backlog items, plans sprints, and balances stakeholder needs' },
  { id: 'product/product-feedback-synthesizer', name: 'Feedback Synthesizer', division: 'Product', description: 'Collects and synthesizes user feedback into actionable product insights' },

  // ── Project Management ─────────────────────────────────────────────────
  { id: 'project-management/project-management-senior-project-manager', name: 'Senior Project Manager', division: 'Project Management', description: 'Manages complex projects, coordinates teams, and ensures on-time delivery' },
  { id: 'project-management/project-management-project-shepherd', name: 'Project Shepherd', division: 'Project Management', description: 'Guides projects through obstacles, unblocks teams, and maintains momentum' },

  // ── Testing ────────────────────────────────────────────────────────────
  { id: 'testing/testing-api-tester', name: 'API Tester', division: 'Testing', description: 'Tests APIs for correctness, performance, and edge cases' },
  { id: 'testing/testing-performance-benchmarker', name: 'Performance Benchmarker', division: 'Testing', description: 'Benchmarks system performance, identifies bottlenecks, and recommends optimizations' },
  { id: 'testing/testing-accessibility-auditor', name: 'Accessibility Auditor', division: 'Testing', description: 'Audits applications for accessibility compliance and inclusive design' },
  { id: 'testing/testing-evidence-collector', name: 'Evidence Collector', division: 'Testing', description: 'Systematically collects and documents testing evidence and results' },

  // ── Marketing ──────────────────────────────────────────────────────────
  { id: 'marketing/marketing-content-creator', name: 'Content Creator', division: 'Marketing', description: 'Creates engaging content for blogs, social media, and marketing campaigns' },
  { id: 'marketing/marketing-seo-specialist', name: 'SEO Specialist', division: 'Marketing', description: 'Optimizes content and websites for search engine visibility and rankings' },
  { id: 'marketing/marketing-growth-hacker', name: 'Growth Hacker', division: 'Marketing', description: 'Experiments with creative growth strategies to acquire and retain users' },

  // ── Sales ──────────────────────────────────────────────────────────────
  { id: 'sales/sales-outbound-strategist', name: 'Outbound Strategist', division: 'Sales', description: 'Develops outbound sales strategies, prospecting sequences, and outreach campaigns' },
  { id: 'sales/sales-sales-engineer', name: 'Sales Engineer', division: 'Sales', description: 'Provides technical expertise during sales process, demos, and proof of concepts' },

  // ── Support ────────────────────────────────────────────────────────────
  { id: 'support/support-support-responder', name: 'Support Responder', division: 'Support', description: 'Handles customer support tickets, resolves issues, and provides helpful responses' },
  { id: 'support/support-analytics-reporter', name: 'Analytics Reporter', division: 'Support', description: 'Analyzes data, creates reports, and surfaces actionable insights' },

  // ── Specialized ────────────────────────────────────────────────────────
  { id: 'specialized/specialized-developer-advocate', name: 'Developer Advocate', division: 'Specialized', description: 'Creates developer content, builds community, and advocates for developer experience' },
  { id: 'specialized/specialized-document-generator', name: 'Document Generator', division: 'Specialized', description: 'Generates structured documents, reports, and formatted content from data' },
  { id: 'specialized/specialized-recruitment-specialist', name: 'Recruitment Specialist', division: 'Specialized', description: 'Sources candidates, screens resumes, and manages hiring pipelines' },
];
