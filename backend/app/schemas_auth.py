"""Request/response models for authentication and organizations."""

from datetime import datetime
from typing import List, Optional
import uuid

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    name: Optional[str] = Field(default=None, max_length=120)
    org_name: Optional[str] = Field(default=None, max_length=120)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    name: Optional[str]
    created_at: datetime


class OrgOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    role: str
    created_at: datetime


class MeOut(BaseModel):
    user: UserOut
    orgs: List[OrgOut]
    active_org_id: uuid.UUID


class CreateOrgRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    name: Optional[str]
    role: str
    joined_at: datetime


class AddMemberRequest(BaseModel):
    email: EmailStr
    role: str = "member"


class UpdateMemberRoleRequest(BaseModel):
    role: str
