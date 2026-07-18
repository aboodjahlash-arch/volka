from typing import Optional
from datetime import datetime, UTC, date
from pydantic import BaseModel, field_validator
from enum import Enum


# VIP emails with unlimited credits
VIP_EMAILS = {"imengomar@gmail.com"}
DAILY_CREDIT_LIMIT = 1  # Tasks per day for regular users


class UserRole(str, Enum):
    ADMIN = "admin"
    USER = "user"


class User(BaseModel):
    """User domain model"""
    id: str
    fullname: str
    email: str
    password_hash: Optional[str] = None
    role: UserRole = UserRole.USER
    is_active: bool = True
    created_at: datetime = datetime.now(UTC)
    updated_at: datetime = datetime.now(UTC)
    last_login_at: Optional[datetime] = None
    # Daily credits system
    daily_credits_used: int = 0
    last_credit_reset_date: Optional[str] = None  # ISO date string YYYY-MM-DD

    @field_validator('fullname')
    @classmethod
    def validate_fullname(cls, v):
        if not v or len(v.strip()) < 2:
            raise ValueError("Full name must be at least 2 characters long")
        return v.strip()

    @field_validator('email')
    @classmethod
    def validate_email(cls, v):
        if not v or '@' not in v:
            raise ValueError("Valid email is required")
        return v.strip().lower()

    def is_vip(self) -> bool:
        """Check if user has unlimited credits"""
        return self.email in VIP_EMAILS or self.role == UserRole.ADMIN

    def get_today_str(self) -> str:
        return date.today().isoformat()

    def reset_daily_credits_if_needed(self):
        """Reset credits if a new day has started"""
        today = self.get_today_str()
        if self.last_credit_reset_date != today:
            self.daily_credits_used = 0
            self.last_credit_reset_date = today

    def has_credits(self) -> bool:
        """Check if user can run a new task"""
        if self.is_vip():
            return True
        self.reset_daily_credits_if_needed()
        return self.daily_credits_used < DAILY_CREDIT_LIMIT

    def consume_credit(self):
        """Consume one daily credit"""
        if not self.is_vip():
            self.reset_daily_credits_if_needed()
            self.daily_credits_used += 1
            self.updated_at = datetime.now(UTC)

    def credits_remaining(self) -> int:
        """Get remaining credits for today"""
        if self.is_vip():
            return 999999
        self.reset_daily_credits_if_needed()
        return max(0, DAILY_CREDIT_LIMIT - self.daily_credits_used)

    def update_last_login(self):
        self.last_login_at = datetime.now(UTC)
        self.updated_at = datetime.now(UTC)

    def deactivate(self):
        self.is_active = False
        self.updated_at = datetime.now(UTC)

    def activate(self):
        self.is_active = True
        self.updated_at = datetime.now(UTC)
