import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AllowedDomainsTab } from './AllowedDomainsTab';
import { DepartmentsTab } from './DepartmentsTab';
import { IntegrationsTab } from './IntegrationsTab';
import { TokensTab } from './TokensTab';
import { UsersTab } from './UsersTab';

export function AdminPage() {
  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-4 md:p-6">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight md:mb-6">Administration</h1>
        <Tabs defaultValue="domains">
          {/* The strip scrolls sideways on phones instead of forcing the page wide. */}
          <div className="overflow-x-auto">
            <TabsList className="min-h-11 md:min-h-8">
              <TabsTrigger value="domains">Allowed domains</TabsTrigger>
              <TabsTrigger value="users">Users</TabsTrigger>
              <TabsTrigger value="departments">Departments</TabsTrigger>
              <TabsTrigger value="tokens">Service tokens</TabsTrigger>
              <TabsTrigger value="integrations">Integrations</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="domains" className="animate-in duration-150 fade-in">
            <AllowedDomainsTab />
          </TabsContent>
          <TabsContent value="users" className="animate-in duration-150 fade-in">
            <UsersTab />
          </TabsContent>
          <TabsContent value="departments" className="animate-in duration-150 fade-in">
            <DepartmentsTab />
          </TabsContent>
          <TabsContent value="tokens" className="animate-in duration-150 fade-in">
            <TokensTab />
          </TabsContent>
          <TabsContent value="integrations" className="animate-in duration-150 fade-in">
            <IntegrationsTab />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
