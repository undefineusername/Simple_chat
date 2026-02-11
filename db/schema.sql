-- Transparent Pipeline Schema

CREATE TABLE IF NOT EXISTS accounts (
    account_uuid VARCHAR(255) PRIMARY KEY, -- Argon2-derived hash
    username VARCHAR(255) UNIQUE NOT NULL, -- Public lookup ID
    account_salt VARCHAR(255) NOT NULL,
    kdf_params JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS friends (
    id SERIAL PRIMARY KEY,
    user_uuid VARCHAR(255) REFERENCES accounts(account_uuid),
    friend_uuid VARCHAR(255) REFERENCES accounts(account_uuid),
    status VARCHAR(50) DEFAULT 'accepted', -- 'pending', 'accepted', 'blocked'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_uuid, friend_uuid)
);

CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_uuid);
CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_uuid);
