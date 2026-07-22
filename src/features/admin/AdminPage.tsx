import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AllowedDomainsTab } from './AllowedDomainsTab';
import { DepartmentsTab } from './DepartmentsTab';
import { UsersTab } from './UsersTab';

export function AdminPage() {
  return (
    <main className="mx-auto w-full max-w-4xl p-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Administration</h1>
      <Tabs defaultValue="domains">
        <TabsList>
          <TabsTrigger value="domains">Allowed domains</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="departments">Departments</TabsTrigger>
        </TabsList>
        <TabsContent value="domains">
          <AllowedDomainsTab />
        </TabsContent>
        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="departments">
          <DepartmentsTab />
        </TabsContent>
      </Tabs>
    </main>
  );
}
