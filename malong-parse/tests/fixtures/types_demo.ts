interface User {
  id: number
  name: string
  email?: string
}

type Status = 'active' | 'inactive' | 'banned'

class UserManager {
  private users: Map<number, User> = new Map()
  
  addUser(user: User): void {
    this.users.set(user.id, user)
  }
  
  getUser(id: number): User | undefined {
    return this.users.get(id)
  }
  
  getActiveUsers(): User[] {
    return Array.from(this.users.values())
      .filter(u => u.email !== undefined)
  }
}

export function createManager(): UserManager {
  return new UserManager()
}
