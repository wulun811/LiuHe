export interface User {
  id: number
  name: string
  email?: string
}

export type UserID = string | number

export enum Role {
  Admin = 'admin',
  Member = 'member',
  Guest = 'guest',
}

export abstract class BaseRepository<T> {
  abstract findById(id: UserID): Promise<T | null>
  abstract save(entity: T): Promise<T>
}

export class UserRepository extends BaseRepository<User> {
  async findById(id: UserID) {
    return null
  }
  async save(entity: User) {
    return entity
  }
}

const { Admin, Guest } = Role
const [first, ...rest] = [1, 2, 3]

export function createUser({ name, email = 'none' }: { name: string; email?: string }) {
  return { id: 1, name, email }
}
